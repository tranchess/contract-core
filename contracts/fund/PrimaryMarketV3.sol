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
import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IWrappedERC20.sol";

contract PrimaryMarketV3 is IPrimaryMarketV3, ReentrancyGuard, ITrancheIndexV2, Ownable {
    event Created(address indexed account, uint256 underlying, uint256 outQ);
    event Redeemed(address indexed account, uint256 inQ, uint256 underlying, uint256 fee);
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
    /// @return outQ Created QUEEN amount
    function getCreation(uint256 underlying) public view override returns (uint256 outQ) {
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundEquivalentTotalQ = fund.getEquivalentTotalQ();
        require(fundUnderlying.add(underlying) <= fundCap, "Exceed fund cap");
        if (fundEquivalentTotalQ == 0) {
            outQ = underlying.mul(fund.underlyingDecimalMultiplier());
            uint256 splitRatio = fund.splitRatio();
            require(splitRatio != 0, "Fund is not initialized");
            uint256 settledDay = fund.currentDay() - 1 days;
            uint256 underlyingPrice = fund.twapOracle().getTwap(settledDay);
            (uint256 navB, uint256 navR) = fund.historicalNavs(settledDay);
            outQ = outQ.mul(underlyingPrice).div(splitRatio).divideDecimal(navB.add(navR));
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
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundEquivalentTotalQ = fund.getEquivalentTotalQ();
        require(fundEquivalentTotalQ > 0, "Cannot calculate creation for empty fund");
        return minOutQ.mul(fundUnderlying).add(fundEquivalentTotalQ - 1).div(fundEquivalentTotalQ);
    }

    function _getRedemptionBeforeFee(uint256 inQ) private view returns (uint256 underlying) {
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundEquivalentTotalQ = fund.getEquivalentTotalQ();
        underlying = inQ.mul(fundUnderlying).div(fundEquivalentTotalQ);
    }

    /// @notice Calculate the result of a redemption.
    /// @param inQ QUEEN amount spent for the redemption
    /// @return underlying Redeemed underlying amount
    /// @return fee Underlying amount charged as redemption fee
    function getRedemption(uint256 inQ)
        public
        view
        override
        returns (uint256 underlying, uint256 fee)
    {
        underlying = _getRedemptionBeforeFee(inQ);
        fee = underlying.multiplyDecimal(redemptionFeeRate);
        underlying = underlying.sub(fee);
    }

    /// @notice Calculate the amount of QUEEN that can be redeemed for at least the given amount
    ///         of underlying tokens.
    /// @dev The return value may not be the minimum solution due to rounding errors.
    /// @param minUnderlying Minimum received underlying amount
    /// @return inQ QUEEN amount that should be redeemed
    function getRedemptionForUnderlying(uint256 minUnderlying)
        external
        view
        override
        returns (uint256 inQ)
    {
        // Assume:
        //   minUnderlying * 1e18 = a * (1e18 - redemptionFeeRate) + b
        //   a * fundEquivalentTotalQ = c * fundUnderlying - d
        // where
        //   a, b, c, d are integers
        //   0 <= b < 1e18 - redemptionFeeRate
        //   0 <= d < fundUnderlying
        // Then
        //   underlyingBeforeFee = a
        //   inQ = c
        //   getRedemption(inQ).underlying
        //     = floor(c * fundUnderlying / fundEquivalentTotalQ) -
        //       - floor(floor(c * fundUnderlying / fundEquivalentTotalQ) * redemptionFeeRate / 1e18)
        //     = ceil(floor(c * fundUnderlying / fundEquivalentTotalQ) * (1e18 - redemptionFeeRate) / 1e18)
        //    >= ceil(floor((c * fundUnderlying - d) / fundEquivalentTotalQ) * (1e18 - redemptionFeeRate) / 1e18)
        //     = ceil(a * (1e18 - redemptionFeeRate) / 1e18)
        //     = (a * (1e18 - redemptionFeeRate) + b) / 1e18        // because b < 1e18
        //     = minUnderlying
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundEquivalentTotalQ = fund.getEquivalentTotalQ();
        uint256 underlyingBeforeFee = minUnderlying.divideDecimal(1e18 - redemptionFeeRate);
        return
            underlyingBeforeFee.mul(fundEquivalentTotalQ).add(fundUnderlying - 1).div(
                fundUnderlying
            );
    }

    /// @notice Calculate the result of a split.
    /// @param inQ QUEEN amount to be split
    /// @return outB Received BISHOP amount, which is also received ROOK amount
    function getSplit(uint256 inQ) public view override returns (uint256 outB) {
        return inQ.multiplyDecimal(fund.splitRatio());
    }

    /// @notice Calculate the amount of QUEEN that can be split into at least the given amount of
    ///         BISHOP and ROOK.
    /// @param minOutB Received BISHOP amount, which is also received ROOK amount
    /// @return inQ QUEEN amount that should be split
    function getSplitForB(uint256 minOutB) external view override returns (uint256 inQ) {
        uint256 splitRatio = fund.splitRatio();
        return minOutB.mul(1e18).add(splitRatio.sub(1)).div(splitRatio);
    }

    /// @notice Calculate the result of a merge.
    /// @param inB Spent BISHOP amount, which is also spent ROOK amount
    /// @return outQ Received QUEEN amount
    /// @return feeQ QUEEN amount charged as merge fee
    function getMerge(uint256 inB) public view override returns (uint256 outQ, uint256 feeQ) {
        uint256 outQBeforeFee = inB.divideDecimal(fund.splitRatio());
        feeQ = outQBeforeFee.multiplyDecimal(mergeFeeRate);
        outQ = outQBeforeFee.sub(feeQ);
    }

    /// @notice Calculate the amount of BISHOP and ROOK that can be merged into at least
    ///      the given amount of QUEEN.
    /// @dev The return value may not be the minimum solution due to rounding errors.
    /// @param minOutQ Minimum received QUEEN amount
    /// @return inB BISHOP amount that should be merged, which is also spent ROOK amount
    function getMergeForQ(uint256 minOutQ) external view override returns (uint256 inB) {
        // Assume:
        //   minOutQ * 1e18 = a * (1e18 - mergeFeeRate) + b
        //   c = ceil(a * splitRatio / 1e18)
        // where a and b are integers and 0 <= b < 1e18 - mergeFeeRate
        // Then
        //   outQBeforeFee = a
        //   inB = c
        //   getMerge(inB).outQ
        //     = c * 1e18 / splitRatio - floor(c * 1e18 / splitRatio * mergeFeeRate / 1e18)
        //     = ceil(c * 1e18 / splitRatio * (1e18 - mergeFeeRate) / 1e18)
        //    >= ceil(a * (1e18 - mergeFeeRate) / 1e18)
        //     = (a * (1e18 - mergeFeeRate) + b) / 1e18         // because b < 1e18
        //     = minOutQ
        uint256 outQBeforeFee = minOutQ.divideDecimal(1e18 - mergeFeeRate);
        inB = outQBeforeFee.mul(fund.splitRatio()).add(1e18 - 1).div(1e18);
    }

    /// @notice Return index of the first queued redemption that cannot be claimed now.
    ///         Users can use this function to determine which indices can be passed to
    ///         `claimRedemptions()`.
    /// @return Index of the first redemption that cannot be claimed now
    function getNewRedemptionQueueHead() external view returns (uint256) {
        uint256 available = _tokenUnderlying.balanceOf(address(fund));
        uint256 l = redemptionQueueHead;
        uint256 r = redemptionQueueTail;
        uint256 startPrefixSum = queuedRedemptions[l].previousPrefixSum;
        // overflow is desired
        if (queuedRedemptions[r].previousPrefixSum - startPrefixSum <= available) {
            return r;
        }
        // Iteration count is bounded by log2(tail - head), which is at most 256.
        while (l + 1 < r) {
            uint256 m = (l + r) / 2;
            if (queuedRedemptions[m].previousPrefixSum - startPrefixSum <= available) {
                l = m;
            } else {
                r = m;
            }
        }
        return l;
    }

    /// @notice Search in the redemption queue.
    /// @param account Owner of the redemptions, or zero address to return all redemptions
    /// @param startIndex Redemption index where the search starts, or zero to start from the head
    /// @param maxIterationCount Maximum number of redemptions to be scanned, or zero for no limit
    /// @return indices Indices of found redemptions
    /// @return underlying Total underlying of found redemptions
    function getQueuedRedemptions(
        address account,
        uint256 startIndex,
        uint256 maxIterationCount
    ) external view returns (uint256[] memory indices, uint256 underlying) {
        uint256 head = redemptionQueueHead;
        uint256 tail = redemptionQueueTail;
        if (startIndex == 0) {
            startIndex = head;
        } else {
            require(startIndex >= head && startIndex <= tail, "startIndex out of bound");
        }
        uint256 endIndex = tail;
        if (maxIterationCount != 0 && tail - startIndex > maxIterationCount) {
            endIndex = startIndex + maxIterationCount;
        }
        indices = new uint256[](endIndex - startIndex);
        uint256 count = 0;
        for (uint256 i = startIndex; i < endIndex; i++) {
            if (account == address(0) || queuedRedemptions[i].account == account) {
                indices[count] = i;
                underlying += queuedRedemptions[i].underlying;
                count++;
            }
        }
        if (count != endIndex - startIndex) {
            // Shrink the array
            assembly {
                mstore(indices, count)
            }
        }
    }

    /// @notice Return whether the fund can change its primary market to another contract.
    function canBeRemovedFromFund() external view override returns (bool) {
        return redemptionQueueHead == redemptionQueueTail;
    }

    /// @notice Create QUEEN using underlying tokens.
    /// @param recipient Address that will receive created QUEEN
    /// @param underlying Spent underlying amount
    /// @param minOutQ Minimum QUEEN amount to be received
    /// @param version The latest rebalance version
    /// @return outQ Received QUEEN amount
    function create(
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) external override nonReentrant returns (uint256 outQ) {
        outQ = _create(recipient, underlying, minOutQ, version);
        _tokenUnderlying.safeTransferFrom(msg.sender, address(fund), underlying);
    }

    /// @notice Create QUEEN using native currency. The underlying must be wrapped token
    ///         of the native currency.
    /// @param recipient Address that will receive created QUEEN
    /// @param minOutQ Minimum amount of QUEEN to be received
    /// @param version The latest rebalance version
    /// @return outQ Received QUEEN amount
    function wrapAndCreate(
        address recipient,
        uint256 minOutQ,
        uint256 version
    ) external payable override nonReentrant returns (uint256 outQ) {
        outQ = _create(recipient, msg.value, minOutQ, version);
        IWrappedERC20(address(_tokenUnderlying)).deposit{value: msg.value}();
        _tokenUnderlying.safeTransfer(address(fund), msg.value);
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
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(recipient, inQ, minUnderlying, version);
    }

    /// @notice Redeem QUEEN to get native currency back. The underlying must be wrapped token
    ///         of the native currency. Revert if there are still some queued redemptions that
    ///         cannot be claimed now.
    /// @param recipient Address that will receive redeemed underlying tokens
    /// @param inQ Spent QUEEN amount
    /// @param minUnderlying Minimum amount of underlying tokens to be received
    /// @param version The latest rebalance version
    /// @return underlying Received underlying amount
    function redeemAndUnwrap(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(address(this), inQ, minUnderlying, version);
        IWrappedERC20(address(_tokenUnderlying)).withdraw(underlying);
        (bool success, ) = recipient.call{value: underlying}("");
        require(success, "Transfer failed");
    }

    function _create(
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) private returns (uint256 outQ) {
        outQ = getCreation(underlying);
        require(outQ >= minOutQ && outQ > 0, "Min QUEEN created");
        fund.primaryMarketMint(TRANCHE_Q, recipient, outQ, version);
        emit Created(recipient, underlying, outQ);
    }

    function _redeem(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) private returns (uint256 underlying) {
        fund.primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        _popRedemptionQueue(0);
        uint256 fee;
        (underlying, fee) = getRedemption(inQ);
        require(underlying >= minUnderlying && underlying > 0, "Min underlying redeemed");
        // Redundant check for user-friendly revert message.
        require(
            underlying <= _tokenUnderlying.balanceOf(address(fund)),
            "Not enough underlying in fund"
        );
        fund.primaryMarketTransferUnderlying(recipient, underlying, fee);
        emit Redeemed(recipient, inQ, underlying, fee);
    }

    /// @notice Redeem QUEEN and wait in the redemption queue. Redeemed underlying tokens will
    ///         be claimable when the fund has enough balance to pay this redemption and all
    ///         previous ones in the queue.
    /// @param recipient Address that will receive redeemed underlying tokens
    /// @param inQ Spent QUEEN amount
    /// @param minUnderlying Minimum amount of underlying tokens to be received
    /// @param version The latest rebalance version
    /// @return underlying Received underlying amount
    /// @return index Index of the queued redemption
    function queueRedemption(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying, uint256 index) {
        fund.primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        uint256 fee;
        (underlying, fee) = getRedemption(inQ);
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
        emit Redeemed(recipient, inQ, underlying, fee);
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
        emit RedemptionPopped(newHead - oldHead, newHead, requiredUnderlying);
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
        uint256 inQ,
        uint256 version
    ) external override returns (uint256 outB) {
        outB = getSplit(inQ);
        fund.primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        fund.primaryMarketMint(TRANCHE_B, recipient, outB, version);
        fund.primaryMarketMint(TRANCHE_R, recipient, outB, version);
        emit Split(recipient, inQ, outB, outB);
    }

    function merge(
        address recipient,
        uint256 inB,
        uint256 version
    ) external override returns (uint256 outQ) {
        uint256 feeQ;
        (outQ, feeQ) = getMerge(inB);
        uint256 feeUnderlying = _getRedemptionBeforeFee(feeQ);
        fund.primaryMarketBurn(TRANCHE_B, msg.sender, inB, version);
        fund.primaryMarketBurn(TRANCHE_R, msg.sender, inB, version);
        fund.primaryMarketMint(TRANCHE_Q, recipient, outQ, version);
        fund.primaryMarketAddDebt(0, feeUnderlying);
        emit Merged(recipient, outQ, inB, inB, feeUnderlying);
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

    /// @notice Receive unwrapped transfer from the wrapped token.
    receive() external payable {}

    modifier onlyFund() {
        require(msg.sender == address(fund), "Only fund");
        _;
    }
}
