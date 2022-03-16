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
    event Redeemed(address indexed account, uint256 shares, uint256 underlying, uint256 fee);
    event Split(address indexed account, uint256 inM, uint256 outA, uint256 outB);
    event Merged(address indexed account, uint256 outM, uint256 inA, uint256 inB);
    event RedemptionQueued(address indexed account, uint256 index, uint256 underlying);
    event RedemptionPopped(uint256 newHead);
    event RedemptionClaimed(address indexed account, uint256 index, uint256 underlying);
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

    struct QueuedRedemption {
        address account;
        uint256 underlying;
        uint256 previousPrefixSum;
    }

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

    /// @notice Queue of redemptions that cannot be claimed yet. Key is a sequential index
    ///         starting from zero. Value is a tuple of user address, redeemed underlying and
    ///         prefix sum before this entry.
    mapping(uint256 => QueuedRedemption) public queuedRedemptions;

    /// @notice Index of the redemption queue head. All redemptions with index smaller than
    ///         this value can be claimed now.
    uint256 public redemptionQueueHead;

    /// @notice Index of the redemption following the last entry of the queue. The next queued
    ///         redemption will be written at this index.
    uint256 public redemptionQueueTail;

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

    /// @notice Calculate the result of a creation.
    /// @param underlying Underlying amount spent for the creation
    /// @return shares Created Token M amount
    function getCreation(uint256 underlying) public view override returns (uint256 shares) {
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

    function _getRedemptionBeforeFee(uint256 shares) private view returns (uint256 underlying) {
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundTotalShares = fund.getTotalShares();
        underlying = shares.mul(fundUnderlying).div(fundTotalShares);
    }

    /// @notice Calculate the result of a redemption.
    /// @param shares Token M amount spent for the redemption
    /// @return underlying Redeemed underlying amount
    /// @return fee Underlying amount charged as redemption fee
    function getRedemption(uint256 shares)
        public
        view
        override
        returns (uint256 underlying, uint256 fee)
    {
        underlying = _getRedemptionBeforeFee(shares);
        fee = underlying.multiplyDecimal(redemptionFeeRate);
        underlying = underlying.sub(fee);
    }

    /// @notice Calculate the result of a split.
    /// @param inM Token M amount to be split
    /// @return outA Received Token A amount
    /// @return outB Received Token B amount
    /// @return feeM Token M amount charged as split fee
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

    /// @notice Calculate the result of a merge.
    /// @param expectA Minimum amount of Token M to be received
    /// @return inA Spent Token A amount
    /// @return inB Spent Token B amount
    /// @return outM Received Token M amount
    /// @return feeM Token M amount charged as merge fee
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

    /// @notice Create Token M using underlying tokens.
    /// @param recipient Address that will receive created Token M
    /// @param underlying Spent underlying amount
    /// @param minShares Minimum amount of Token M to be received
    /// @param version The latest rebalance version
    /// @return shares Received Token M amount
    function create(
        address recipient,
        uint256 underlying,
        uint256 minShares,
        uint256 version
    ) external override nonReentrant returns (uint256 shares) {
        shares = _create(recipient, underlying, minShares, version);
        _tokenUnderlying.safeTransferFrom(msg.sender, address(fund), underlying);
    }

    /// @notice Create Token M using native currency. The underlying must be wrapped token
    ///         of the native currency.
    /// @param recipient Address that will receive created Token M
    /// @param minShares Minimum amount of Token M to be received
    /// @param version The latest rebalance version
    /// @return shares Received Token M amount
    function wrapAndCreate(
        address recipient,
        uint256 minShares,
        uint256 version
    ) external payable override nonReentrant returns (uint256 shares) {
        shares = _create(recipient, msg.value, minShares, version);
        IWrappedERC20(address(_tokenUnderlying)).deposit{value: msg.value}();
        _tokenUnderlying.safeTransfer(address(fund), msg.value);
    }

    /// @notice Redeem Token M to get underlying tokens back. Revert if there are still some
    ///         queued redemptions that cannot be claimed now.
    /// @param recipient Address that will receive redeemed underlying tokens
    /// @param shares Spent Token M amount
    /// @param minUnderlying Minimum amount of underlying tokens to be received
    /// @param version The latest rebalance version
    /// @return underlying Received underlying amount
    function redeem(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(recipient, shares, minUnderlying, version);
    }

    /// @notice Redeem Token M to get native currency back. The underlying must be wrapped token
    ///         of the native currency. Revert if there are still some queued redemptions that
    ///         cannot be claimed now.
    /// @param recipient Address that will receive redeemed underlying tokens
    /// @param shares Spent Token M amount
    /// @param minUnderlying Minimum amount of underlying tokens to be received
    /// @param version The latest rebalance version
    /// @return underlying Received underlying amount
    function redeemAndUnwrap(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(address(this), shares, minUnderlying, version);
        IWrappedERC20(address(_tokenUnderlying)).withdraw(underlying);
        (bool success, ) = recipient.call{value: underlying}("");
        require(success, "Transfer failed");
    }

    function _create(
        address recipient,
        uint256 underlying,
        uint256 minShares,
        uint256 version
    ) private onlyActive returns (uint256 shares) {
        require(underlying >= minCreationUnderlying, "Min amount");
        shares = getCreation(underlying);
        require(shares >= minShares, "Min shares created");
        fund.mint(TRANCHE_M, recipient, shares, version);
        emit Created(recipient, underlying, shares);
    }

    function _redeem(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) private onlyActive returns (uint256 underlying) {
        require(shares != 0, "Zero shares");
        fund.burn(TRANCHE_M, msg.sender, shares, version);
        _popRedemptionQueue(0);
        uint256 fee;
        (underlying, fee) = getRedemption(shares);
        require(underlying >= minUnderlying, "Min underlying redeemed");
        // Redundant check for user-friendly revert message.
        require(
            underlying <= _tokenUnderlying.balanceOf(address(fund)),
            "Not enough underlying in fund"
        );
        fund.primaryMarketTransferUnderlying(recipient, underlying, fee);
        emit Redeemed(recipient, shares, underlying, fee);
    }

    /// @notice Redeem Token M and wait in the redemption queue. Redeemed underlying tokens will
    ///         be claimable when the fund has enough balance to pay this redemption and all
    ///         previous ones in the queue.
    /// @param recipient Address that will receive redeemed underlying tokens
    /// @param shares Spent Token M amount
    /// @param minUnderlying Minimum amount of underlying tokens to be received
    /// @param version The latest rebalance version
    /// @return underlying Received underlying amount
    /// @return index Index of the queued redemption
    function queueRedemption(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external override onlyActive nonReentrant returns (uint256 underlying, uint256 index) {
        require(shares != 0, "Zero shares");
        fund.burn(TRANCHE_M, msg.sender, shares, version);
        uint256 fee;
        (underlying, fee) = getRedemption(shares);
        require(underlying >= minUnderlying, "Min underlying redeemed");
        index = redemptionQueueTail;
        QueuedRedemption storage newRedemption = queuedRedemptions[index];
        newRedemption.account = recipient;
        newRedemption.underlying = underlying;
        // overflow is desired
        queuedRedemptions[index + 1].previousPrefixSum =
            newRedemption.previousPrefixSum +
            underlying;
        redemptionQueueTail = index + 1;
        fund.primaryMarketAddDebt(underlying, fee);
        emit Redeemed(recipient, shares, underlying, fee);
        emit RedemptionQueued(recipient, index, underlying);
    }

    /// @dev Remove a given number of redemptions from the front of the redemption queue and fetch
    ///      underlying tokens of these redemptions from the fund. Revert if the fund cannot pay
    ///      these redemptions now.
    /// @param count The number of redemptions to be removed, or zero to completely empty the queue
    function _popRedemptionQueue(uint256 count) private {
        uint256 oldHead = redemptionQueueHead;
        uint256 oldTail = redemptionQueueTail;
        uint256 newHead;
        if (count == 0) {
            if (oldHead == oldTail) {
                return;
            }
            newHead = oldTail;
        } else {
            newHead = oldHead.add(count);
            require(newHead <= oldTail, "Redemption queue out of bound");
        }
        // overflow is desired
        uint256 requiredUnderlying =
            queuedRedemptions[newHead].previousPrefixSum -
                queuedRedemptions[oldHead].previousPrefixSum;
        // Redundant check for user-friendly revert message.
        require(
            requiredUnderlying <= _tokenUnderlying.balanceOf(address(fund)),
            "Not enough underlying in fund"
        );
        fund.primaryMarketPayDebt(requiredUnderlying);
        redemptionQueueHead = newHead;
        emit RedemptionPopped(newHead);
    }

    /// @notice Claim underlying tokens of queued redemptions. All these redemptions must
    ///         belong to the same account.
    /// @param account Recipient of the redemptions
    /// @param indices Indices of the redemptions in the queue
    /// @return underlying Total claimed underlying amount
    function claimRedemptions(address account, uint256[] calldata indices)
        external
        override
        nonReentrant
        returns (uint256 underlying)
    {
        underlying = _claimRedemptions(account, indices);
        _tokenUnderlying.safeTransfer(account, underlying);
    }

    /// @notice Claim native currency of queued redemptions. The underlying must be wrapped token
    ///         of the native currency. All these redemptions must belong to the same account.
    /// @param account Recipient of the redemptions
    /// @param indices Indices of the redemptions in the queue
    /// @return underlying Total claimed underlying amount
    function claimRedemptionsAndUnwrap(address account, uint256[] calldata indices)
        external
        override
        nonReentrant
        returns (uint256 underlying)
    {
        underlying = _claimRedemptions(account, indices);
        IWrappedERC20(address(_tokenUnderlying)).withdraw(underlying);
        (bool success, ) = account.call{value: underlying}("");
        require(success, "Transfer failed");
    }

    function _claimRedemptions(address account, uint256[] calldata indices)
        private
        returns (uint256 underlying)
    {
        uint256 count = indices.length;
        uint256 head = redemptionQueueHead;
        uint256 maxIndex = 0;
        for (uint256 i = 0; i < count; i++) {
            if (maxIndex < indices[i]) {
                maxIndex = indices[i];
            }
        }
        if (maxIndex >= head) {
            _popRedemptionQueue(maxIndex - head + 1);
        }
        for (uint256 i = 0; i < count; i++) {
            QueuedRedemption storage redemption = queuedRedemptions[indices[i]];
            require(
                redemption.account == account && redemption.underlying != 0,
                "Invalid redemption index"
            );
            underlying = underlying.add(redemption.underlying);
            emit RedemptionClaimed(account, indices[i], redemption.underlying);
            redemption.account = address(0);
            redemption.underlying = 0;
            redemption.previousPrefixSum = 0;
        }
    }

    function split(
        address recipient,
        uint256 inM,
        uint256 version
    ) external override onlyActive returns (uint256 outA, uint256 outB) {
        uint256 feeM;
        (outA, outB, feeM) = getSplit(inM);
        fund.burn(TRANCHE_M, msg.sender, inM, version);
        fund.mint(TRANCHE_A, recipient, outA, version);
        fund.mint(TRANCHE_B, recipient, outB, version);
        fund.primaryMarketAddDebt(0, _getRedemptionBeforeFee(feeM));
        emit Split(msg.sender, inM, outA, outB);
    }

    function merge(
        address recipient,
        uint256 inA,
        uint256 version
    ) external override onlyActive returns (uint256 inB, uint256 outM) {
        uint256 feeM;
        (inA, inB, outM, feeM) = getMerge(inA);
        fund.burn(TRANCHE_A, msg.sender, inA, version);
        fund.burn(TRANCHE_B, msg.sender, inB, version);
        fund.mint(TRANCHE_M, recipient, outM, version);
        fund.primaryMarketAddDebt(0, _getRedemptionBeforeFee(feeM));
        emit Merged(msg.sender, outM, inA, inB);
    }

    /// @dev Nothing to do for daily fund settlement.
    function settle(
        uint256 day,
        uint256,
        uint256,
        uint256,
        uint256
    )
        external
        override
        onlyFund
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        emit Settled(day, 0, 0, 0, 0, 0);
        return (0, 0, 0, 0, 0);
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
