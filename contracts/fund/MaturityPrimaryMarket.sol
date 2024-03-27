// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/SafeDecimalMath.sol";

import "../interfaces/IPrimaryMarketV5.sol";
import "../interfaces/IFundV5.sol";
import "../interfaces/IFundForPrimaryMarketV4.sol";
import "../interfaces/ITrancheIndexV2.sol";

contract MaturityPrimaryMarket is IPrimaryMarketV5, ReentrancyGuard, ITrancheIndexV2, Ownable {
    event Created(address indexed account, uint256 underlying, uint256 outQ);
    event Redeemed(address indexed account, uint256 inQ, uint256 underlying, uint256 feeQ);
    event RedeemedBR(
        address indexed account,
        uint256 inB,
        uint256 inR,
        uint256 underlying,
        uint256 feeQ
    );
    event Split(address indexed account, uint256 inQ, uint256 outB, uint256 outR);
    event Merged(
        address indexed account,
        uint256 outQ,
        uint256 inB,
        uint256 inR,
        uint256 feeUnderlying
    );
    event RedemptionQueued(address indexed account, uint256 index, uint256 underlying);
    event RedemptionPopped(uint256 count, uint256 newHead, uint256 requiredUnderlying);
    event RedemptionClaimed(address indexed account, uint256 index, uint256 underlying);
    event FundCapUpdated(uint256 newCap);
    event RedemptionFeeRateUpdated(uint256 newRedemptionFeeRate);
    event MergeFeeRateUpdated(uint256 newMergeFeeRate);

    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    struct QueuedRedemption {
        address account;
        uint256 underlying;
        uint256 previousPrefixSum;
    }

    uint256 private constant MAX_REDEMPTION_FEE_RATE = 0.01e18;
    uint256 private constant MAX_MERGE_FEE_RATE = 0.01e18;

    address public immutable override fund;
    bool public immutable redemptionFlag;
    uint256 private immutable _weightB;
    IERC20 private immutable _tokenUnderlying;

    uint256 public redemptionFeeRate;
    uint256 public mergeFeeRate;

    /// @notice The upper limit of underlying that the fund can hold. This contract rejects
    ///         creations that may break this limit.
    /// @dev This limit can be bypassed if the fund has multiple primary markets.
    ///
    ///      Set it to uint(-1) to skip the check and save gas.
    uint256 public fundCap;

    constructor(
        address fund_,
        uint256 redemptionFeeRate_,
        uint256 mergeFeeRate_,
        uint256 fundCap_,
        bool redemptionFlag_
    ) public Ownable() {
        fund = fund_;
        _tokenUnderlying = IERC20(IFundV3(fund_).tokenUnderlying());
        _updateRedemptionFeeRate(redemptionFeeRate_);
        _updateMergeFeeRate(mergeFeeRate_);
        _updateFundCap(fundCap_);
        _weightB = IFundV5(fund_).weightB();
        redemptionFlag = redemptionFlag_;
    }

    /// @notice Calculate the result of a creation.
    /// @param underlying Underlying amount spent for the creation
    /// @return outQ Created QUEEN amount
    function getCreation(uint256 underlying) public view override returns (uint256 outQ) {
        uint256 fundUnderlying = IFundV3(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV3(fund).getEquivalentTotalQ();
        require(fundUnderlying.add(underlying) <= fundCap, "Exceed fund cap");
        if (fundEquivalentTotalQ == 0) {
            outQ = underlying.mul(IFundV3(fund).underlyingDecimalMultiplier());
            uint256 splitRatio = IFundV3(fund).splitRatio();
            require(splitRatio != 0, "Fund is not initialized");
            uint256 settledDay = IFundV5(fund).getSettledDay();
            uint256 underlyingPrice = IFundV3(fund).twapOracle().getTwap(settledDay);
            (uint256 navB, uint256 navR) = IFundV3(fund).historicalNavs(settledDay);
            outQ = outQ.mul(underlyingPrice).div(splitRatio).divideDecimal(
                navB.mul(_weightB).add(navR)
            );
        } else {
            require(
                fundUnderlying != 0,
                "Cannot create QUEEN for fund with shares but no underlying"
            );
            outQ = underlying.mul(fundEquivalentTotalQ).div(fundUnderlying);
        }
    }

    /// @notice Calculate the amount of underlying tokens to create at least the given QUEEN amount.
    ///         This only works with non-empty fund for simplicity.
    /// @param minOutQ Minimum received QUEEN amount
    /// @return underlying Underlying amount that should be used for creation
    function getCreationForQ(uint256 minOutQ) external view override returns (uint256 underlying) {
        // Assume:
        //   minOutQ * fundUnderlying = a * fundEquivalentTotalQ - b
        // where a and b are integers and 0 <= b < fundEquivalentTotalQ
        // Then
        //   underlying = a
        //   getCreation(underlying)
        //     = floor(a * fundEquivalentTotalQ / fundUnderlying)
        //    >= floor((a * fundEquivalentTotalQ - b) / fundUnderlying)
        //     = minOutQ
        //   getCreation(underlying - 1)
        //     = floor((a * fundEquivalentTotalQ - fundEquivalentTotalQ) / fundUnderlying)
        //     < (a * fundEquivalentTotalQ - b) / fundUnderlying
        //     = minOutQ
        uint256 fundUnderlying = IFundV3(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV3(fund).getEquivalentTotalQ();
        require(fundEquivalentTotalQ > 0, "Cannot calculate creation for empty fund");
        return minOutQ.mul(fundUnderlying).add(fundEquivalentTotalQ - 1).div(fundEquivalentTotalQ);
    }

    function _getRedemption(uint256 inQ) private view returns (uint256 underlying) {
        uint256 fundUnderlying = IFundV3(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV3(fund).getEquivalentTotalQ();
        underlying = inQ.mul(fundUnderlying).div(fundEquivalentTotalQ);
    }

    /// @notice Calculate the result of a redemption.
    /// @param inQ QUEEN amount spent for the redemption
    /// @return underlying Redeemed underlying amount
    /// @return feeQ QUEEN amount charged as redemption fee
    function getRedemption(
        uint256 inQ
    ) public view override returns (uint256 underlying, uint256 feeQ) {
        feeQ = inQ.multiplyDecimal(redemptionFeeRate);
        underlying = _getRedemption(inQ - feeQ);
    }

    /// @notice Calculate the result of a redemption using BISHOP and ROOK.
    ///         Q = B / splitRatio * navB  / navSum
    ///         Q = R / splitRatio * navR  / navSum
    /// @param inB Spent BISHOP amount
    /// @param inR Spent ROOK amount
    /// @return underlying Redeemed underlying amount
    function getRedemptionBR(uint256 inB, uint256 inR) public view returns (uint256 underlying) {
        uint256 lastDay = IFundV5(fund).currentDay() - IFundV5(fund).settlementPeriod();
        (uint256 navB, uint256 navR) = IFundV5(fund).historicalNavs(lastDay);
        uint256 navSum = navB.mul(_weightB).add(navR);
        uint256 splitRatio = IFundV3(fund).splitRatio();
        uint256 amountQFromB = inB.mul(navB).div(navSum).divideDecimal(splitRatio);
        uint256 amountQFromR = inR.mul(navR).div(navSum).divideDecimal(splitRatio);
        // Calculate the equivalent underlying amount.
        underlying = _getRedemption(amountQFromB.add(amountQFromR));
    }

    /// @notice Calculate the amount of QUEEN that can be redeemed for at least the given amount
    ///         of underlying tokens.
    /// @dev The return value may not be the minimum solution due to rounding errors.
    /// @param minUnderlying Minimum received underlying amount
    /// @return inQ QUEEN amount that should be redeemed
    function getRedemptionForUnderlying(
        uint256 minUnderlying
    ) external view override returns (uint256 inQ) {
        // Assume:
        //   minUnderlying * fundEquivalentTotalQ = a * fundUnderlying - b
        //   a * 1e18 = c * (1e18 - redemptionFeeRate) + d
        // where
        //   a, b, c, d are integers
        //   0 <= b < fundUnderlying
        //   0 <= d < 1e18 - redemeptionFeeRate
        // Then
        //   inQAfterFee = a
        //   inQ = c
        //   getRedemption(inQ).underlying
        //     = floor((c - floor(c * redemptionFeeRate / 1e18)) * fundUnderlying / fundEquivalentTotalQ)
        //     = floor(ceil(c * (1e18 - redemptionFeeRate) / 1e18) * fundUnderlying / fundEquivalentTotalQ)
        //     = floor(((c * (1e18 - redemptionFeeRate) + d) / 1e18) * fundUnderlying / fundEquivalentTotalQ)
        //     = floor(a * fundUnderlying / fundEquivalentTotalQ)
        //     => floor((a * fundUnderlying - b) / fundEquivalentTotalQ)
        //     = minUnderlying
        uint256 fundUnderlying = IFundV3(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV3(fund).getEquivalentTotalQ();
        uint256 inQAfterFee = minUnderlying.mul(fundEquivalentTotalQ).add(fundUnderlying - 1).div(
            fundUnderlying
        );
        return inQAfterFee.divideDecimal(1e18 - redemptionFeeRate);
    }

    /// @notice Calculate the result of a split.
    /// @param inQ QUEEN amount to be split
    /// @return outB Received BISHOP amount
    /// @return outR Received ROOK amount
    function getSplit(uint256 inQ) public view override returns (uint256 outB, uint256 outR) {
        outR = inQ.multiplyDecimal(IFundV5(fund).splitRatio());
        outB = outR.mul(_weightB);
    }

    /// @notice Calculate the amount of QUEEN that can be split into at least the given amount of
    ///         BISHOP and ROOK.
    /// @param minOutR Received ROOK amount
    /// @return inQ QUEEN amount that should be split
    /// @return outB Received BISHOP amount
    function getSplitForR(
        uint256 minOutR
    ) external view override returns (uint256 inQ, uint256 outB) {
        uint256 splitRatio = IFundV3(fund).splitRatio();
        outB = minOutR.mul(_weightB);
        inQ = minOutR.mul(1e18).add(splitRatio.sub(1)).div(splitRatio);
    }

    /// @notice Calculate the result of a merge.
    /// @param inB Spent BISHOP amount
    /// @return inR Spent ROOK amount
    /// @return outQ Received QUEEN amount
    /// @return feeQ QUEEN amount charged as merge fee
    function getMerge(
        uint256 inB
    ) public view override returns (uint256 inR, uint256 outQ, uint256 feeQ) {
        uint256 splitRatio = IFundV5(fund).splitRatio();
        uint256 outQBeforeFee = inB.divideDecimal(splitRatio.mul(_weightB));
        feeQ = outQBeforeFee.multiplyDecimal(mergeFeeRate);
        outQ = outQBeforeFee.sub(feeQ);
        inR = outQBeforeFee.multiplyDecimal(splitRatio);
    }

    /// @notice Calculate the result of a merge using ROOK.
    /// @param inR Spent ROOK amount
    /// @return inB Spent BISHOP amount
    /// @return outQ Received QUEEN amount
    /// @return feeQ QUEEN amount charged as merge fee
    function getMergeByR(
        uint256 inR
    ) public view override returns (uint256 inB, uint256 outQ, uint256 feeQ) {
        inB = inR.mul(_weightB);
        uint256 splitRatio = IFundV5(fund).splitRatio();
        uint256 outQBeforeFee = inR.divideDecimal(splitRatio);
        feeQ = outQBeforeFee.multiplyDecimal(mergeFeeRate);
        outQ = outQBeforeFee.sub(feeQ);
    }

    /// @notice Return whether the fund can change its primary market to another contract.
    function canBeRemovedFromFund() external view override returns (bool) {
        return true;
    }

    /// @notice Create QUEEN using underlying tokens. This function should be called by
    ///         a smart contract, which transfers underlying tokens to this contract
    ///         in the same transaction.
    /// @param recipient Address that will receive created QUEEN
    /// @param minOutQ Minimum QUEEN amount to be received
    /// @param version The latest rebalance version
    /// @return outQ Received QUEEN amount
    function create(
        address recipient,
        uint256 minOutQ,
        uint256 version
    ) external override nonReentrant whenFundActive returns (uint256 outQ) {
        uint256 underlying = _tokenUnderlying.balanceOf(address(this));
        outQ = getCreation(underlying);
        require(outQ >= minOutQ && outQ > 0, "Min QUEEN created");
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_Q, recipient, outQ, version);
        _tokenUnderlying.safeTransfer(fund, underlying);
        emit Created(recipient, underlying, outQ);
    }

    /// @notice Redeem QUEEN to get underlying tokens back. Revert if there are still some
    ///         queued redemptions that cannot be claimed now.
    /// @param recipient Address that will receive redeemed underlying tokens
    /// @param inQ Spent QUEEN amount
    /// @param minUnderlying Minimum amount of underlying tokens to be received
    /// @param version The latest rebalance version
    /// @return underlying Received underlying amount
    function redeem(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external override nonReentrant allowRedemption returns (uint256 underlying) {
        uint256 feeQ;
        (underlying, feeQ) = getRedemption(inQ);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        require(underlying >= minUnderlying && underlying > 0, "Min underlying redeemed");
        // Redundant check for user-friendly revert message.
        require(underlying <= _tokenUnderlying.balanceOf(fund), "Not enough underlying in fund");
        IFundForPrimaryMarketV4(fund).primaryMarketTransferUnderlying(recipient, underlying, feeQ);
        emit Redeemed(recipient, inQ, underlying, feeQ);
    }

    function redeemBR(
        address recipient,
        uint256 inB,
        uint256 inR,
        uint256 minUnderlying,
        uint256 version
    ) external nonReentrant allowRedemption whenFundFrozen returns (uint256 underlying) {
        underlying = getRedemptionBR(inB, inR);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_B, msg.sender, inB, version);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_R, msg.sender, inR, version);
        require(underlying >= minUnderlying && underlying > 0, "Min underlying redeemed");
        // Redundant check for user-friendly revert message.
        require(underlying <= _tokenUnderlying.balanceOf(fund), "Not enough underlying in fund");
        IFundForPrimaryMarketV4(fund).primaryMarketTransferUnderlying(recipient, underlying, 0);
        emit RedeemedBR(recipient, inB, inR, underlying, 0);
    }

    function redeemAndUnwrap(
        address,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256) {
        revert("Not Supported");
    }

    function split(
        address recipient,
        uint256 inQ,
        uint256 version
    ) external override whenFundActive returns (uint256 outB, uint256 outR) {
        (outB, outR) = getSplit(inQ);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_B, recipient, outB, version);
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_R, recipient, outR, version);
        emit Split(recipient, inQ, outB, outR);
    }

    function merge(
        address recipient,
        uint256 inB,
        uint256 version
    ) external override whenFundActive returns (uint256 outQ) {
        uint256 inR;
        uint256 feeQ;
        (inR, outQ, feeQ) = getMerge(inB);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_B, msg.sender, inB, version);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_R, msg.sender, inR, version);
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_Q, recipient, outQ, version);
        IFundForPrimaryMarketV4(fund).primaryMarketAddDebtAndFee(0, feeQ);
        emit Merged(recipient, outQ, inB, inR, feeQ);
    }

    /// @dev Nothing to do for daily fund settlement.
    function settle(uint256 day) external override onlyFund {}

    function _updateFundCap(uint256 newCap) private {
        fundCap = newCap;
        emit FundCapUpdated(newCap);
    }

    function updateFundCap(uint256 newCap) external onlyOwner {
        _updateFundCap(newCap);
    }

    function _updateRedemptionFeeRate(uint256 newRedemptionFeeRate) private {
        require(newRedemptionFeeRate <= MAX_REDEMPTION_FEE_RATE, "Exceed max redemption fee rate");
        redemptionFeeRate = newRedemptionFeeRate;
        emit RedemptionFeeRateUpdated(newRedemptionFeeRate);
    }

    function updateRedemptionFeeRate(uint256 newRedemptionFeeRate) external onlyOwner {
        _updateRedemptionFeeRate(newRedemptionFeeRate);
    }

    function _updateMergeFeeRate(uint256 newMergeFeeRate) private {
        require(newMergeFeeRate <= MAX_MERGE_FEE_RATE, "Exceed max merge fee rate");
        mergeFeeRate = newMergeFeeRate;
        emit MergeFeeRateUpdated(newMergeFeeRate);
    }

    function updateMergeFeeRate(uint256 newMergeFeeRate) external onlyOwner {
        _updateMergeFeeRate(newMergeFeeRate);
    }

    modifier onlyFund() {
        require(msg.sender == fund, "Only fund");
        _;
    }

    modifier allowRedemption() {
        require(redemptionFlag, "Redemption N/A");
        _;
    }

    modifier whenFundFrozen() {
        require(IFundV5(fund).frozen(), "Fund not frozen");
        _;
    }

    modifier whenFundActive() {
        require(!IFundV5(fund).frozen(), "Fund frozen");
        _;
    }

    function queueRedemption(
        address,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256, uint256) {
        revert("Not Supported");
    }

    function claimRedemptions(address, uint256[] calldata) external override returns (uint256) {
        revert("Not Supported");
    }

    function claimRedemptionsAndUnwrap(
        address,
        uint256[] calldata
    ) external override returns (uint256) {
        revert("Not Supported");
    }

    function claimRedemptionsAndUnwrapWstETH(
        address,
        uint256[] calldata
    ) external override returns (uint256) {
        revert("Not Supported");
    }

    function redeemAndUnwrapWstETH(
        address,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256) {
        revert("Not Supported");
    }
}
