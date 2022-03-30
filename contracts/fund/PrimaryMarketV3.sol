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
    event RedemptionPopped(uint256 count, uint256 newHead);
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

    IFundV3 public immutable override fund;
    IERC20 private immutable _tokenUnderlying;

    uint256 public redemptionFeeRate;
    uint256 public mergeFeeRate;

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
        uint256 mergeFeeRate_,
        uint256 fundCap_
    ) public Ownable() {
        fund = IFundV3(fund_);
        _tokenUnderlying = IERC20(IFundV3(fund_).tokenUnderlying());
        _updateRedemptionFeeRate(redemptionFeeRate_);
        _updateMergeFeeRate(mergeFeeRate_);
        _updateFundCap(fundCap_);
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

    /// @notice Calculate the amount of underlying tokens to create at least the given amount of
    ///         Token M. This only works with non-empty fund for simplicity.
    /// @param minShares Minimum received Token M amount
    /// @return underlying Underlying amount that should be used for creation
    function getCreationForShares(uint256 minShares)
        external
        view
        override
        returns (uint256 underlying)
    {
        // Assume:
        //   minShares * fundUnderlying = a * fundTotalShares - b
        // where a and b are integers and 0 <= b < fundTotalShares
        // Then
        //   underlying = a
        //   getCreation(underlying)
        //     = floor(a * fundTotalShares / fundUnderlying)
        //    >= floor((a * fundTotalShares - b) / fundUnderlying)
        //     = minShares
        //   getCreation(underlying - 1)
        //     = floor((a * fundTotalShares - fundTotalShares) / fundUnderlying)
        //     < (a * fundTotalShares - b) / fundUnderlying
        //     = minShares
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundTotalShares = fund.getTotalShares();
        require(fundTotalShares > 0, "Cannot calculate creation for empty fund");
        return minShares.mul(fundUnderlying).add(fundTotalShares - 1).div(fundTotalShares);
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

    /// @notice Calculate the amount of Token M that can be redeemed for at least the given amount
    ///         of underlying tokens.
    /// @dev The return value may not be the minimum solution due to rounding errors.
    /// @param minUnderlying Minimum received underlying amount
    /// @return shares Token M amount that should be redeemed
    function getRedemptionForUnderlying(uint256 minUnderlying)
        external
        view
        override
        returns (uint256 shares)
    {
        // Assume:
        //   minUnderlying * 1e18 = a * (1e18 - redemptionFeeRate) + b
        //   a * fundTotalShares = c * fundUnderlying - d
        // where
        //   a, b, c, d are integers
        //   0 <= b < 1e18 - redemptionFeeRate
        //   0 <= d < fundUnderlying
        // Then
        //   underlyingBeforeFee = a
        //   shares = c
        //   getRedemption(shares).underlying
        //     = floor(c * fundUnderlying / fundTotalShares) -
        //       - floor(floor(c * fundUnderlying / fundTotalShares) * redemptionFeeRate / 1e18)
        //     = ceil(floor(c * fundUnderlying / fundTotalShares) * (1e18 - redemptionFeeRate) / 1e18)
        //    >= ceil(floor((c * fundUnderlying - d) / fundTotalShares) * (1e18 - redemptionFeeRate) / 1e18)
        //     = ceil(a * (1e18 - redemptionFeeRate) / 1e18)
        //     = (a * (1e18 - redemptionFeeRate) + b) / 1e18        // because b < 1e18
        //     = minUnderlying
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundTotalShares = fund.getTotalShares();
        uint256 underlyingBeforeFee = minUnderlying.divideDecimal(1e18 - redemptionFeeRate);
        return underlyingBeforeFee.mul(fundTotalShares).add(fundUnderlying - 1).div(fundUnderlying);
    }

    /// @notice Calculate the result of a split.
    /// @param inM Token M amount to be split
    /// @return outAB Received amount of Token A and Token B
    function getSplit(uint256 inM) public view override returns (uint256 outAB) {
        return inM / 2;
    }

    /// @notice Calculate the amount of Token M that can be split into the given amount of
    ///         Token A and Token B.
    /// @param minOutAB Received Token A and Token B amount
    /// @return inM Token M amount that should be split
    function getSplitForAB(uint256 minOutAB) external view override returns (uint256 inM) {
        return minOutAB * 2;
    }

    /// @notice Calculate the result of a merge.
    /// @param inAB Spent amount of Token A and Token B
    /// @return outM Received Token M amount
    /// @return feeM Token M amount charged as merge fee
    function getMerge(uint256 inAB) public view override returns (uint256 outM, uint256 feeM) {
        uint256 outMBeforeFee = inAB.mul(2);
        feeM = outMBeforeFee.multiplyDecimal(mergeFeeRate);
        outM = outMBeforeFee.sub(feeM);
    }

    /// @notice Calculate the amount of Token A and Token B that can be merged into at least
    ///      the given amount of Token M.
    /// @dev The return value may not be the minimum solution due to rounding errors.
    /// @param minOutM Minimum received Token M amount
    /// @return inAB Token A and Token B amount that should be merged
    function getMergeForM(uint256 minOutM) external view override returns (uint256 inAB) {
        // Assume:
        //   minOutM * 1e18 = a * (1e18 - mergeFeeRate) + b
        // where a and b are integers and 0 <= b < 1e18 - mergeFeeRate
        // Then
        //   outMBeforeFee = a
        //   inAB = ceil(a / 2)
        //   getMerge(inAB).outM
        //     = inAB * 2 - floor(inAB * 2 * mergeFeeRate / 1e18)
        //     = ceil(inAB * 2 * (1e18 - mergeFeeRate) / 1e18)
        //    >= ceil(a * (1e18 - mergeFeeRate) / 1e18)
        //     = (a * (1e18 - mergeFeeRate) + b) / 1e18         // because b < 1e18
        //     = minOutM
        uint256 outMBeforeFee = minOutM.divideDecimal(1e18 - mergeFeeRate);
        inAB = outMBeforeFee.add(1) / 2;
    }

    /// @notice Return whether the fund can change its primary market to another contract.
    function canBeRemovedFromFund() external view override returns (bool) {
        return redemptionQueueHead == redemptionQueueTail;
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
        shares = getCreation(underlying);
        require(shares >= minShares && shares > 0, "Min shares created");
        fund.primaryMarketMint(TRANCHE_M, recipient, shares, version);
        emit Created(recipient, underlying, shares);
    }

    function _redeem(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) private onlyActive returns (uint256 underlying) {
        fund.primaryMarketBurn(TRANCHE_M, msg.sender, shares, version);
        _popRedemptionQueue(0);
        uint256 fee;
        (underlying, fee) = getRedemption(shares);
        require(underlying >= minUnderlying && underlying > 0, "Min underlying redeemed");
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
        fund.primaryMarketBurn(TRANCHE_M, msg.sender, shares, version);
        uint256 fee;
        (underlying, fee) = getRedemption(shares);
        require(underlying >= minUnderlying && underlying > 0, "Min underlying redeemed");
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

    /// @notice Remove a given number of redemptions from the front of the redemption queue and
    ///         fetch underlying tokens of these redemptions from the fund. Revert if the fund
    ///         cannot pay these redemptions now.
    /// @param count The number of redemptions to be removed, or zero to completely empty the queue
    function popRedemptionQueue(uint256 count) external nonReentrant {
        _popRedemptionQueue(count);
    }

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
        emit RedemptionPopped(newHead - oldHead, newHead);
    }

    /// @notice Claim underlying tokens of queued redemptions. All these redemptions must
    ///         belong to the same account.
    /// @param account Recipient of the redemptions
    /// @param indices Indices of the redemptions in the queue, which must be in increasing order
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
    /// @param indices Indices of the redemptions in the queue, which must be in increasing order
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
        if (count == 0) {
            return 0;
        }
        uint256 head = redemptionQueueHead;
        if (indices[count - 1] >= head) {
            _popRedemptionQueue(indices[count - 1] - head + 1);
        }
        for (uint256 i = 0; i < count; i++) {
            require(i == 0 || indices[i] > indices[i - 1], "Indices out of order");
            QueuedRedemption storage redemption = queuedRedemptions[indices[i]];
            uint256 redemptionUnderlying = redemption.underlying;
            require(
                redemption.account == account && redemptionUnderlying != 0,
                "Invalid redemption index"
            );
            underlying = underlying.add(redemptionUnderlying);
            emit RedemptionClaimed(account, indices[i], redemptionUnderlying);
            delete queuedRedemptions[indices[i]];
        }
    }

    function split(
        address recipient,
        uint256 inM,
        uint256 version
    ) external override onlyActive returns (uint256 outAB) {
        outAB = getSplit(inM);
        fund.primaryMarketBurn(TRANCHE_M, msg.sender, inM, version);
        fund.primaryMarketMint(TRANCHE_A, recipient, outAB, version);
        fund.primaryMarketMint(TRANCHE_B, recipient, outAB, version);
        emit Split(recipient, inM, outAB, outAB);
    }

    function merge(
        address recipient,
        uint256 inAB,
        uint256 version
    ) external override onlyActive returns (uint256 outM) {
        uint256 feeM;
        (outM, feeM) = getMerge(inAB);
        fund.primaryMarketBurn(TRANCHE_A, msg.sender, inAB, version);
        fund.primaryMarketBurn(TRANCHE_B, msg.sender, inAB, version);
        fund.primaryMarketMint(TRANCHE_M, recipient, outM, version);
        fund.primaryMarketAddDebt(0, _getRedemptionBeforeFee(feeM));
        emit Merged(recipient, outM, inAB, inAB);
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
