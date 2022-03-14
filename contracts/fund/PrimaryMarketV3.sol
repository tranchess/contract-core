// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/SafeDecimalMath.sol";

import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/ITrancheIndex.sol";
import "../interfaces/IWrappedERC20.sol";

contract PrimaryMarketV3 is IPrimaryMarketV3, ReentrancyGuard, ITrancheIndex, Ownable {
    event Created(address indexed account, uint256 underlying, uint256 shares);
    event Redeemed(
        address indexed account,
        uint256 shares,
        uint256 underlying,
        uint256 redemptionFee
    );
    event Split(address indexed account, uint256 inM, uint256 outA, uint256 outB);
    event Merged(address indexed account, uint256 outM, uint256 inA, uint256 inB);
    event Claimed(address indexed account, uint256 createdShares, uint256 redeemedUnderlying); // XXX
    event Settled(
        uint256 indexed day,
        uint256 sharesToMint,
        uint256 sharesToBurn,
        uint256 creationUnderlying,
        uint256 redemptionUnderlying,
        uint256 fee
    );
    event FundCapUpdated(uint256 newCap);
    event RedemptionFeeRateUpdated(uint256 newRedemptionFeeRate);
    event SplitFeeRateUpdated(uint256 newSplitFeeRate);
    event MergeFeeRateUpdated(uint256 newMergeFeeRate);
    event MinCreationUnderlyingUpdated(uint256 newMinCreationUnderlying);

    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    uint256 private constant MAX_REDEMPTION_FEE_RATE = 0.01e18;
    uint256 private constant MAX_SPLIT_FEE_RATE = 0.01e18;
    uint256 private constant MAX_MERGE_FEE_RATE = 0.01e18;

    IFundV3 public immutable override fund;
    IERC20 private immutable _tokenUnderlying;

    uint256 public redemptionFeeRate;
    uint256 public splitFeeRate;
    uint256 public mergeFeeRate;
    uint256 public minCreationUnderlying;

    /// @notice The upper limit of underlying that the fund can hold. This contract rejects
    ///         creations that may break this limit.
    /// @dev This limit can be bypassed if the fund has multiple primary markets.
    ///
    ///      Set it to uint(-1) to skip the check and save gas.
    uint256 public fundCap;

    uint256 public currentFeeInShares;

    constructor(
        address fund_,
        uint256 redemptionFeeRate_,
        uint256 splitFeeRate_,
        uint256 mergeFeeRate_,
        uint256 minCreationUnderlying_,
        uint256 fundCap_
    ) public Ownable() {
        require(redemptionFeeRate_ <= MAX_REDEMPTION_FEE_RATE, "Exceed max redemption fee rate");
        require(splitFeeRate_ <= MAX_SPLIT_FEE_RATE, "Exceed max split fee rate");
        require(mergeFeeRate_ <= MAX_MERGE_FEE_RATE, "Exceed max merge fee rate");
        fund = IFundV3(fund_);
        _tokenUnderlying = IERC20(IFundV3(fund_).tokenUnderlying());
        redemptionFeeRate = redemptionFeeRate_;
        splitFeeRate = splitFeeRate_;
        mergeFeeRate = mergeFeeRate_;
        minCreationUnderlying = minCreationUnderlying_;
        fundCap = fundCap_;
    }

    function getCreation(uint256 underlying) public view override returns (uint256 shares) {
        require(underlying >= minCreationUnderlying, "Min amount");
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundTotalShares = fund.getTotalShares();
        require(fundUnderlying.add(underlying) <= fundCap, "Exceed fund cap");
        if (fundTotalShares == 0) {
            uint256 day = fund.currentDay();
            uint256 underlyingPrice = fund.twapOracle().getTwap(day - 1 days);
            (uint256 prevNavM, , ) = fund.historicalNavs(day - 1 days);
            require(underlyingPrice != 0 && prevNavM != 0, "Zero NAV or underlying price");
            shares = underlying.mul(underlyingPrice).mul(fund.underlyingDecimalMultiplier()).div(
                prevNavM
            );
        } else {
            require(
                fundUnderlying != 0,
                "Cannot create shares for fund with shares but no underlying"
            );
            shares = underlying.mul(fundTotalShares).div(fundUnderlying);
        }
    }

    function getRedemption(uint256 shares)
        public
        view
        override
        returns (uint256 underlying, uint256 fee)
    {
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundTotalShares = fund.getTotalShares();
        underlying = shares.mul(fundUnderlying).div(fundTotalShares);
        fee = underlying.multiplyDecimal(redemptionFeeRate);
        underlying = underlying.sub(fee);
    }

    function getSplit(uint256 inM)
        public
        view
        override
        returns (
            uint256 outA,
            uint256 outB,
            uint256 feeM
        )
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        // Charge splitting fee and round it to a multiple of (weightA + weightB)
        uint256 unit = inM.sub(inM.multiplyDecimal(splitFeeRate)) / (weightA + weightB);
        require(unit > 0, "Too little to split");
        uint256 inMAfterFee = unit * (weightA + weightB);
        outA = unit * weightA;
        outB = inMAfterFee - outA;
        feeM = inM - inMAfterFee;
    }

    function getTokenAMForSplitB(uint256 outB)
        external
        view
        override
        returns (uint256 outA, uint256 inM)
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        outA = outB.mul(weightA) / weightB;
        uint256 inMAfterFee = outA.add(outB);
        inM = inMAfterFee.divideDecimal(uint256(1e18).sub(splitFeeRate)).add(1);
    }

    function getMerge(uint256 expectA)
        public
        view
        override
        returns (
            uint256 inA,
            uint256 inB,
            uint256 outM,
            uint256 feeM
        )
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        // Round to tranche weights
        uint256 unit = expectA / weightA;
        require(unit > 0, "Too little to merge");
        // Keep unmergable Token A unchanged.
        inA = unit * weightA;
        inB = unit.mul(weightB);
        uint256 outMBeforeFee = inA.add(inB);
        feeM = outMBeforeFee.multiplyDecimal(mergeFeeRate);
        outM = outMBeforeFee.sub(feeM);
    }

    function getTokenAMForMergeB(uint256 inB)
        external
        view
        override
        returns (uint256 inA, uint256 outM)
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        // Round to tranche weights
        uint256 unit = inB / weightB;
        require(unit > 0, "Too little to merge");
        // Keep unmergable Token A unchanged.
        inA = unit * weightA;
        inB = unit * weightB;
        uint256 outMBeforeFee = inA.add(inB);
        uint256 feeM = outMBeforeFee.multiplyDecimal(mergeFeeRate);
        outM = outMBeforeFee.sub(feeM);
    }

    function create(
        address recipient,
        uint256 underlying,
        uint256 minShares,
        uint256 version
    ) external override nonReentrant returns (uint256 shares) {
        shares = _create(recipient, underlying, version);
        require(shares >= minShares, "Min shares created");
        _tokenUnderlying.safeTransferFrom(msg.sender, address(fund), underlying);
    }

    function wrapAndCreate(
        address recipient,
        uint256 minShares,
        uint256 version
    ) external payable override nonReentrant returns (uint256 shares) {
        shares = _create(recipient, msg.value, version);
        require(shares >= minShares, "Min shares created");
        IWrappedERC20(address(_tokenUnderlying)).deposit{value: msg.value}();
        _tokenUnderlying.safeTransfer(address(fund), msg.value);
    }

    function delayRedeem(
        address recipient,
        uint256 shares,
        uint256 version
    ) external override onlyActive nonReentrant {
        require(shares != 0, "Zero shares");
        // TODO
        emit Redeemed(recipient, shares, 0, 0);
    }

    function redeem(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(recipient, shares, version);
        require(underlying >= minUnderlying, "Min underlying redeemed");
    }

    function redeemAndUnwrap(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(address(this), shares, version);
        require(underlying >= minUnderlying, "Min underlying redeemed");
        IWrappedERC20(address(_tokenUnderlying)).withdraw(underlying);
        (bool success, ) = recipient.call{value: underlying}("");
        require(success, "Transfer failed");
    }

    function _create(
        address recipient,
        uint256 underlying,
        uint256 version
    ) private onlyActive returns (uint256 shares) {
        shares = getCreation(underlying);
        fund.mint(TRANCHE_M, recipient, shares, version);
        emit Created(recipient, underlying, shares);
    }

    function _redeem(
        address recipient,
        uint256 shares,
        uint256 version
    ) private onlyActive returns (uint256 underlying) {
        require(shares != 0, "Zero shares");
        fund.burn(TRANCHE_M, msg.sender, shares, version);
        uint256 fee;
        (underlying, fee) = getRedemption(shares);
        uint256 balance = _tokenUnderlying.balanceOf(address(fund));
        require(underlying <= balance, "Not enough available hot balance");
        fund.transferToPrimaryMarket(recipient, underlying, fee);
        emit Redeemed(recipient, shares, underlying, fee);
    }

    function split(
        address recipient,
        uint256 inM,
        uint256 version
    ) external override onlyActive returns (uint256 outA, uint256 outB) {
        uint256 feeM;
        (outA, outB, feeM) = getSplit(inM);
        currentFeeInShares = currentFeeInShares.add(feeM);
        fund.burn(TRANCHE_M, msg.sender, inM, version);
        fund.mint(TRANCHE_A, recipient, outA, version);
        fund.mint(TRANCHE_B, recipient, outB, version);
        fund.mint(TRANCHE_M, address(this), feeM, version);
        emit Split(msg.sender, inM, outA, outB);
    }

    function merge(
        address recipient,
        uint256 inA,
        uint256 version
    ) external override onlyActive returns (uint256 inB, uint256 outM) {
        uint256 feeM;
        (inA, inB, outM, feeM) = getMerge(inA);
        currentFeeInShares = currentFeeInShares.add(feeM);
        fund.burn(TRANCHE_A, msg.sender, inA, version);
        fund.burn(TRANCHE_B, msg.sender, inB, version);
        fund.mint(TRANCHE_M, recipient, outM, version);
        fund.mint(TRANCHE_M, address(this), feeM, version);
        emit Merged(msg.sender, outM, inA, inB);
    }

    /// @notice Settle split and merge fee that is charged as Token M in this trading day.
    ///         This function can only be called from the Fund contract. It should be called
    ///         after protocol fee is collected and before rebalance is triggered for the same
    ///         trading day.
    ///
    ///         This function does not mint or burn shares, nor transfer underlying assets.
    ///         It returns the following changes that should be done by the fund:
    ///
    ///         1. Mint or burn net shares, which is only split/merge fee in this implementation.
    ///         2. Transfer underlying to or from this contract, which is always zero in this implementation.
    ///         3. Transfer fee in underlying assets to the governance address.
    ///
    /// @param day The trading day to settle
    /// @param fundTotalShares Total shares of the fund (as if all Token A and B are merged)
    /// @param fundUnderlying Underlying assets in the fund
    /// @return sharesToMint Amount of Token M to mint for creations
    /// @return sharesToBurn Amount of Token M to burn for redemptions and split/merge fee
    /// @return creationUnderlying Underlying assets received for creations (including creation fee)
    /// @return redemptionUnderlying Underlying assets to be redeemed (excluding redemption fee)
    /// @return fee Total fee in underlying assets for the fund to transfer to the governance address,
    ///         which is the split/merge fee in this implementation
    function settle(
        uint256 day,
        uint256 fundTotalShares,
        uint256 fundUnderlying,
        uint256, /* underlyingPrice */
        uint256 /* previousNav */
    )
        external
        override
        nonReentrant
        onlyFund
        returns (
            uint256 sharesToMint,
            uint256 sharesToBurn,
            uint256 creationUnderlying,
            uint256 redemptionUnderlying,
            uint256 fee
        )
    {
        // Redeem split and merge fee
        uint256 feeInShares = currentFeeInShares;
        if (feeInShares > 0) {
            sharesToBurn = feeInShares;
            fee = feeInShares.mul(fundUnderlying).div(fundTotalShares);
            currentFeeInShares = 0;
        }
        emit Settled(day, 0, sharesToBurn, 0, 0, fee);
    }

    function updateFundCap(uint256 newCap) external onlyOwner {
        fundCap = newCap;
        emit FundCapUpdated(newCap);
    }

    function updateRedemptionFeeRate(uint256 newRedemptionFeeRate) external onlyOwner {
        require(newRedemptionFeeRate <= MAX_REDEMPTION_FEE_RATE, "Exceed max redemption fee rate");
        redemptionFeeRate = newRedemptionFeeRate;
        emit RedemptionFeeRateUpdated(newRedemptionFeeRate);
    }

    function updateSplitFeeRate(uint256 newSplitFeeRate) external onlyOwner {
        require(newSplitFeeRate <= MAX_SPLIT_FEE_RATE, "Exceed max split fee rate");
        splitFeeRate = newSplitFeeRate;
        emit SplitFeeRateUpdated(newSplitFeeRate);
    }

    function updateMergeFeeRate(uint256 newMergeFeeRate) external onlyOwner {
        require(newMergeFeeRate <= MAX_MERGE_FEE_RATE, "Exceed max merge fee rate");
        mergeFeeRate = newMergeFeeRate;
        emit MergeFeeRateUpdated(newMergeFeeRate);
    }

    function updateMinCreationUnderlying(uint256 newMinCreationUnderlying) external onlyOwner {
        minCreationUnderlying = newMinCreationUnderlying;
        emit MinCreationUnderlyingUpdated(newMinCreationUnderlying);
    }

    /// @notice Receive unwrapped transfer from the wrapped token.
    receive() external payable {}

    modifier onlyActive() {
        require(fund.isPrimaryMarketActive(address(this), block.timestamp), "Only when active");
        _;
    }

    modifier onlyFund() {
        require(msg.sender == address(fund), "Only fund");
        _;
    }
}
