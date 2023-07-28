// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../../utils/SafeDecimalMath.sol";

import "../../interfaces/IFundV4.sol";
import "../../interfaces/IFundForPrimaryMarketV4.sol";
import "../../interfaces/ITrancheIndexV2.sol";
import "../../interfaces/IWrappedERC20.sol";

interface INonfungibleRedemptionDescriptor {
    function tokenURI(
        uint256 tokenId,
        uint256 amountQ,
        uint256 amountUnderlying,
        uint256 seed
    ) external view returns (string memory);

    function generateSeed(uint256 tokenId, uint256 amountQ) external view returns (uint256);
}

/// @title EIP-721 Metadata Update Extension
interface IERC4906 is IERC165, IERC721 {
    /// @dev This event emits when the metadata of a token is changed.
    ///      So that the third-party platforms such as NFT market could
    ///      timely update the images and related attributes of the NFT.
    event MetadataUpdate(uint256 _tokenId);

    /// @dev This event emits when the metadata of a range of tokens is changed.
    ///      So that the third-party platforms such as NFT market could
    ///      timely update the images and related attributes of the NFTs.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
}

contract EthPrimaryMarket is ReentrancyGuard, ITrancheIndexV2, Ownable, ERC721, IERC4906 {
    event Created(address indexed account, uint256 underlying, uint256 outQ);
    event Redeemed(address indexed account, uint256 inQ, uint256 underlying, uint256 feeQ);
    event Split(address indexed account, uint256 inQ, uint256 outB, uint256 outR);
    event Merged(
        address indexed account,
        uint256 outQ,
        uint256 inB,
        uint256 inR,
        uint256 feeUnderlying
    );
    event RedemptionQueued(address indexed account, uint256 index, uint256 underlying);
    event RedemptionFinalized(uint256 nextFinalizationIndex, uint256 inQ, uint256 underlying);
    event RedemptionPopped(uint256 count, uint256 newHead, uint256 requiredUnderlying);
    event RedemptionClaimed(address indexed account, uint256 index, uint256 underlying);
    event FundCapUpdated(uint256 newCap);
    event MergeFeeRateUpdated(uint256 newMergeFeeRate);
    event RedemptionBoundsUpdated(uint256 newLowerBound, uint256 newUpperBound);

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    struct QueuedRedemption {
        uint256 amountQ;
        uint256 previousPrefixSum;
        uint256 seed;
    }

    struct RedemptionRate {
        uint256 nextIndex;
        // ETH/Queen rate is with 10^27 precision.
        uint256 underlyingPerQ;
    }

    uint256 private constant MAX_MERGE_FEE_RATE = 0.01e18;
    uint256 public constant redemptionFeeRate = 0;

    address public immutable fund;
    IERC20 private immutable _tokenUnderlying;
    INonfungibleRedemptionDescriptor private immutable _descriptor;

    uint256 public mergeFeeRate;

    /// @notice The upper limit of underlying that the fund can hold. This contract rejects
    ///         creations that may break this limit.
    uint256 public fundCap;

    /// @notice Queue of redemptions that cannot be claimed yet. Key is a sequential index
    ///         starting from zero. Value is a tuple of redeemed QUEEN and prefix sum before
    ///         this entry.
    mapping(uint256 => QueuedRedemption) public queuedRedemptions;

    /// @notice Total underlying tokens of claimable queued redemptions.
    uint256 public claimableUnderlying;

    /// @notice Index of the redemption queue head. All redemptions with index smaller than
    ///         this value can be claimed now.
    uint256 public redemptionQueueHead;

    /// @notice Index of the redemption following the last entry of the queue. The next queued
    ///         redemption will be written at this index.
    uint256 public redemptionQueueTail;

    /// @notice Rates of underlying tokens per redeemed QUEEN. Key is a sequential index starting
    ///         from zero. Each value corresponds to a continuous part of the redemption queue that
    ///         was finalized in a single transaction.
    mapping(uint256 => RedemptionRate) public redemptionRates;

    /// @notice Total number of redemption rates.
    uint256 public redemptionRateSize;

    /// @notice Minimal amount to redeem by a single request
    uint256 public minRedemptionBound;

    /// @notice Maximum amount to redeem by a single request
    uint256 public maxRedemptionBound;

    constructor(
        address fund_,
        uint256 mergeFeeRate_,
        uint256 fundCap_,
        string memory name_,
        string memory symbol_,
        address descriptor_,
        uint256 minRedemptionBound_,
        uint256 maxRedemptionBound_
    ) public Ownable() ERC721(name_, symbol_) {
        fund = fund_;
        _tokenUnderlying = IERC20(IFundV4(fund_).tokenUnderlying());
        _updateMergeFeeRate(mergeFeeRate_);
        _updateFundCap(fundCap_);
        _descriptor = INonfungibleRedemptionDescriptor(descriptor_);
        _updateRedemptionBounds(minRedemptionBound_, maxRedemptionBound_);
        _registerInterface(bytes4(0x49064906));
    }

    /// @notice Calculate the result of a creation.
    /// @param underlying Underlying amount spent for the creation
    /// @return outQ Created QUEEN amount
    function getCreation(uint256 underlying) public view returns (uint256 outQ) {
        uint256 fundUnderlying = IFundV4(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV4(fund).getEquivalentTotalQ();
        require(fundUnderlying.add(underlying) <= fundCap, "Exceed fund cap");
        if (fundEquivalentTotalQ == 0) {
            outQ = underlying.mul(IFundV4(fund).underlyingDecimalMultiplier());
            uint256 splitRatio = IFundV4(fund).splitRatio();
            require(splitRatio != 0, "Fund is not initialized");
            uint256 settledDay = IFundV4(fund).currentDay() - 1 days;
            uint256 underlyingPrice = IFundV4(fund).twapOracle().getTwap(settledDay);
            (uint256 navB, uint256 navR) = IFundV4(fund).historicalNavs(settledDay);
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
    function getCreationForQ(uint256 minOutQ) external view returns (uint256 underlying) {
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
        uint256 fundUnderlying = IFundV4(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV4(fund).getEquivalentTotalQ();
        require(fundEquivalentTotalQ > 0, "Cannot calculate creation for empty fund");
        return minOutQ.mul(fundUnderlying).add(fundEquivalentTotalQ - 1).div(fundEquivalentTotalQ);
    }

    function _getRedemption(uint256 inQ) private view returns (uint256 underlying) {
        uint256 fundUnderlying = IFundV4(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV4(fund).getEquivalentTotalQ();
        underlying = inQ.mul(fundUnderlying).div(fundEquivalentTotalQ);
    }

    /// @notice Calculate the result of a redemption.
    /// @param inQ QUEEN amount spent for the redemption
    /// @return underlying Redeemed underlying amount
    /// @return feeQ QUEEN amount charged as redemption fee
    function getRedemption(uint256 inQ) public view returns (uint256 underlying, uint256 feeQ) {
        underlying = _getRedemption(inQ);
        feeQ = 0;
    }

    /// @notice Calculate the amount of QUEEN that can be redeemed for at least the given amount
    ///         of underlying tokens.
    /// @dev The return value may not be the minimum solution due to rounding errors.
    /// @param minUnderlying Minimum received underlying amount
    /// @return inQ QUEEN amount that should be redeemed
    function getRedemptionForUnderlying(uint256 minUnderlying) external view returns (uint256 inQ) {
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
        //   underlying
        //     = floor((c - floor(c * redemptionFeeRate / 1e18)) * fundUnderlying / fundEquivalentTotalQ)
        //     = floor(ceil(c * (1e18 - redemptionFeeRate) / 1e18) * fundUnderlying / fundEquivalentTotalQ)
        //     = floor(((c * (1e18 - redemptionFeeRate) + d) / 1e18) * fundUnderlying / fundEquivalentTotalQ)
        //     = floor(a * fundUnderlying / fundEquivalentTotalQ)
        //     => floor((a * fundUnderlying - b) / fundEquivalentTotalQ)
        //     = minUnderlying
        uint256 fundUnderlying = IFundV4(fund).getTotalUnderlying();
        uint256 fundEquivalentTotalQ = IFundV4(fund).getEquivalentTotalQ();
        uint256 inQAfterFee = minUnderlying.mul(fundEquivalentTotalQ).add(fundUnderlying - 1).div(
            fundUnderlying
        );
        return inQAfterFee.divideDecimal(1e18 - redemptionFeeRate);
    }

    /// @notice Calculate the result of a split.
    /// @param inQ QUEEN amount to be split
    /// @return outB Received BISHOP amount, which is also received ROOK amount
    function getSplit(uint256 inQ) public view returns (uint256 outB) {
        return inQ.multiplyDecimal(IFundV4(fund).splitRatio());
    }

    /// @notice Calculate the amount of QUEEN that can be split into at least the given amount of
    ///         BISHOP and ROOK.
    /// @param minOutB Received BISHOP amount, which is also received ROOK amount
    /// @return inQ QUEEN amount that should be split
    function getSplitForB(uint256 minOutB) external view returns (uint256 inQ) {
        uint256 splitRatio = IFundV4(fund).splitRatio();
        return minOutB.mul(1e18).add(splitRatio.sub(1)).div(splitRatio);
    }

    /// @notice Calculate the result of a merge.
    /// @param inB Spent BISHOP amount, which is also spent ROOK amount
    /// @return outQ Received QUEEN amount
    /// @return feeQ QUEEN amount charged as merge fee
    function getMerge(uint256 inB) public view returns (uint256 outQ, uint256 feeQ) {
        uint256 outQBeforeFee = inB.divideDecimal(IFundV4(fund).splitRatio());
        feeQ = outQBeforeFee.multiplyDecimal(mergeFeeRate);
        outQ = outQBeforeFee.sub(feeQ);
    }

    /// @notice Calculate the amount of BISHOP and ROOK that can be merged into at least
    ///      the given amount of QUEEN.
    /// @dev The return value may not be the minimum solution due to rounding errors.
    /// @param minOutQ Minimum received QUEEN amount
    /// @return inB BISHOP amount that should be merged, which is also spent ROOK amount
    function getMergeForQ(uint256 minOutQ) external view returns (uint256 inB) {
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
        inB = outQBeforeFee.mul(IFundV4(fund).splitRatio()).add(1e18 - 1).div(1e18);
    }

    /// @notice Return index of the first queued redemption that cannot be claimed now.
    ///         Users can use this function to determine which indices can be passed to
    ///         `claimRedemptions()`.
    /// @return Index of the first redemption that cannot be claimed now
    function getNewRedemptionQueueHead() public view returns (uint256) {
        uint256 available = _tokenUnderlying.balanceOf(fund);
        uint256 l = redemptionQueueHead;
        uint256 startPrefixSum = queuedRedemptions[l].previousPrefixSum;
        uint256 rateSize = redemptionRateSize;
        uint256 rateIndex = getRedemptionRateIndex(l);
        uint256 r = l;
        while (rateIndex < rateSize) {
            r = redemptionRates[rateIndex].nextIndex;
            uint256 endPrefixSum = queuedRedemptions[r].previousPrefixSum;
            uint256 underlying = (endPrefixSum - startPrefixSum).multiplyDecimalPrecise(
                redemptionRates[rateIndex].underlyingPerQ
            );
            if (available < underlying) {
                break;
            }
            available -= underlying;
            l = r;
            startPrefixSum = endPrefixSum;
            rateIndex += 1;
        }
        if (rateIndex >= rateSize) {
            return r; // All finalized redemptions can be claimed
        }
        // Iteration count is bounded by log2(tail - head), which is at most 256.
        uint256 underlyingPerQ = redemptionRates[rateIndex].underlyingPerQ;
        while (l + 1 < r) {
            uint256 m = (l + r) / 2;
            uint256 underlying = (queuedRedemptions[m].previousPrefixSum - startPrefixSum)
                .multiplyDecimalPrecise(underlyingPerQ);
            if (underlying <= available) {
                l = m;
            } else {
                r = m;
            }
        }
        return l;
    }

    function getRedemptionRateIndexOfHead() external view returns (uint256) {
        return getRedemptionRateIndex(redemptionQueueHead);
    }

    /// @notice Search the redemption rate index of a queued redemption.
    /// @return Index of the redemption rate that covers the given queued redemption, or index
    ///         beyond the last redemption rate if this redemption is not finalized yet.
    function getRedemptionRateIndex(uint256 index) public view returns (uint256) {
        uint256 l = 0;
        uint256 r = redemptionRateSize;
        if (r == 0) return 0;
        // If the index is greater than the redemption rate size, it is not yet finalized.
        // Return the index of the next potential finalization.
        if (redemptionRates[r - 1].nextIndex <= index) {
            return r;
        }
        while (l + 1 < r) {
            uint256 m = (l + r) / 2;
            if (redemptionRates[m - 1].nextIndex <= index) {
                l = m;
            } else {
                r = m;
            }
        }
        return l;
    }

    /// @notice Return claimable underlying tokens of a queued redemption, or zero if
    ///         the redemption is not finalized yet.
    function getRedemptionUnderlying(uint256 index) public view returns (uint256) {
        uint256 rateIndex = getRedemptionRateIndex(index);
        return
            rateIndex < redemptionRateSize
                ? queuedRedemptions[index].amountQ.multiplyDecimalPrecise(
                    redemptionRates[rateIndex].underlyingPerQ
                )
                : 0;
    }

    /// @notice Get queued redemptions of an account. This function returns all information
    ///         required to claim underlying tokens from these redemptions.
    /// @param account Owner of the redemptions
    /// @return indices Indices of found redemptions. Note that there are no guarantees on the
    ///                 ordering.
    /// @return rateIndices Redemption rate indices of found redemptions
    /// @return rateIndexOfHead Redemption rate index of the first redemption in the queue
    ///         (index `redemptionQueueHead`)
    /// @return newRedemptionQueueHead Index of the first redemption that cannot be claimed now
    /// @return amountQ Total amount of QUEEN in found redemptions
    /// @return underlying Total claimable underlying tokens in found redemptions
    function getQueuedRedemptions(
        address account
    )
        external
        view
        returns (
            uint256[] memory indices,
            uint256[] memory rateIndices,
            uint256 rateIndexOfHead,
            uint256 newRedemptionQueueHead,
            uint256 amountQ,
            uint256 underlying
        )
    {
        newRedemptionQueueHead = getNewRedemptionQueueHead();
        uint256 count = balanceOf(account);
        indices = new uint256[](count);
        rateIndices = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 index = tokenOfOwnerByIndex(account, i);
            indices[i] = index;
            rateIndices[i] = getRedemptionRateIndex(index);
            amountQ += queuedRedemptions[index].amountQ;
            if (index < newRedemptionQueueHead) {
                underlying += getRedemptionUnderlying(index);
            }
        }
        rateIndexOfHead = getRedemptionRateIndex(redemptionQueueHead);
    }

    function getNextFinalizationIndex() public view returns (uint256 index) {
        if (redemptionRateSize == 0) return 0;
        return redemptionRates[redemptionRateSize - 1].nextIndex;
    }

    /// @notice Return whether the fund can change its primary market to another contract.
    function canBeRemovedFromFund() external view returns (bool) {
        return redemptionQueueHead == redemptionQueueTail;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId));
        uint256 amountQ = queuedRedemptions[tokenId].amountQ;
        uint256 amountUnderlying = getRedemptionUnderlying(tokenId);
        return
            _descriptor.tokenURI(
                tokenId,
                amountQ,
                amountUnderlying,
                queuedRedemptions[tokenId].seed
            );
    }

    // save bytecode by removing implementation of unused method
    function baseURI() public view override returns (string memory) {}

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
    ) external nonReentrant returns (uint256 outQ) {
        uint256 underlying = _tokenUnderlying.balanceOf(address(this)).sub(claimableUnderlying);
        outQ = getCreation(underlying);
        require(outQ >= minOutQ && outQ > 0, "Min QUEEN created");
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_Q, recipient, outQ, version);
        _tokenUnderlying.safeTransfer(fund, underlying);
        emit Created(recipient, underlying, outQ);
    }

    /// @notice Redeem QUEEN and wait in the redemption queue. Redeemed underlying tokens will
    ///         be claimable when the fund has enough balance to pay this redemption and all
    ///         previous ones in the queue.
    /// @param recipient Address that will receive redeemed underlying tokens
    /// @param inQ Spent QUEEN amount
    /// @param version The latest rebalance version
    /// @return underlying Received underlying amount, always return zero
    /// @return index Index of the queued redemption
    function queueRedemption(
        address recipient,
        uint256 inQ,
        uint256, // minUnderlying is ignored
        uint256 version
    ) external nonReentrant returns (uint256 underlying, uint256 index) {
        require(inQ >= minRedemptionBound && inQ <= maxRedemptionBound, "Invalid amount");
        underlying = 0;
        index = redemptionQueueTail;
        QueuedRedemption storage newRedemption = queuedRedemptions[index];
        newRedemption.amountQ = inQ;
        // overflow is desired
        queuedRedemptions[index + 1].previousPrefixSum = newRedemption.previousPrefixSum + inQ;
        redemptionQueueTail = index + 1;
        // Transfer QUEEN from the sender to this contract
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_Q, address(this), inQ, version);
        newRedemption.seed = _descriptor.generateSeed(index, inQ);
        emit RedemptionQueued(recipient, index, inQ);
        // Mint the redemption NFT
        _safeMint(recipient, index);
    }

    function finalizeRedemptions(uint256 count) external {
        require(msg.sender == IFundV4(fund).strategy(), "Only Strategy");
        uint256 oldFinalizedIndex = getNextFinalizationIndex();
        uint256 newFinalizedIndex = oldFinalizedIndex.add(count);
        require(newFinalizedIndex <= redemptionQueueTail, "Redemption queue out of bound");

        // overflow is desired
        uint256 amountQ = queuedRedemptions[newFinalizedIndex].previousPrefixSum -
            queuedRedemptions[oldFinalizedIndex].previousPrefixSum;

        (uint256 underlying, ) = getRedemption(amountQ);
        uint256 version = IFundV4(fund).getRebalanceSize();
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_Q, address(this), amountQ, version);
        IFundForPrimaryMarketV4(fund).primaryMarketAddDebtAndFee(underlying, 0);
        emit Redeemed(address(0), amountQ, underlying, 0);
        redemptionRates[redemptionRateSize++] = RedemptionRate({
            nextIndex: newFinalizedIndex,
            underlyingPerQ: underlying.divideDecimalPrecise(amountQ)
        });
        emit RedemptionFinalized(newFinalizedIndex, amountQ, underlying);
        emit BatchMetadataUpdate(oldFinalizedIndex, newFinalizedIndex - 1);
    }

    /// @notice Remove a given number of redemptions from the front of the redemption queue and
    ///         fetch underlying tokens of these redemptions from the fund. Revert if the fund
    ///         cannot pay these redemptions now.
    /// @param count The number of redemptions to be removed, or zero to completely empty the queue
    /// @param rateIndexOfHead Redemption rate index of the first redemption in the queue
    ///        (index `redemptionQueueHead`). Call `getRedemptionRateIndexOfHead()` for this value.
    function popRedemptionQueue(uint256 count, uint256 rateIndexOfHead) external nonReentrant {
        _popRedemptionQueue(count, rateIndexOfHead);
    }

    function _popRedemptionQueue(uint256 count, uint256 rateIndexOfHead) private {
        uint256 oldHead = redemptionQueueHead;
        uint256 oldTail = getNextFinalizationIndex();
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

        require(rateIndexOfHead < redemptionRateSize, "Invalid rate index");
        require(
            rateIndexOfHead == 0 || oldHead >= redemptionRates[rateIndexOfHead - 1].nextIndex,
            "Invalid rate index"
        );
        require(oldHead < redemptionRates[rateIndexOfHead].nextIndex, "Invalid rate index");

        uint256 startIndex = oldHead;
        uint256 requiredUnderlying = 0;
        while (startIndex < newHead) {
            uint256 nextIndex = redemptionRates[rateIndexOfHead].nextIndex;
            uint256 endIndex = newHead.min(nextIndex);
            requiredUnderlying = requiredUnderlying.add(
                redemptionRates[rateIndexOfHead].underlyingPerQ.multiplyDecimalPrecise(
                    queuedRedemptions[endIndex].previousPrefixSum -
                        queuedRedemptions[startIndex].previousPrefixSum
                ) // overflow is desired
            );
            if (endIndex == nextIndex) {
                rateIndexOfHead++;
            }
            startIndex = endIndex;
        }
        if (newHead == oldTail) {
            // The fund's debt can be slightly larger than the sum of all finalized redemptions
            // due to rounding errors. In this case, we completely clear the debt, so that it
            // won't block `FundV4.applyStrategyUpdate()`.
            uint256 debt = IFundV4(fund).getTotalDebt();
            require(debt >= requiredUnderlying);
            requiredUnderlying = debt;
        }
        // Redundant check for user-friendly revert message.
        require(
            requiredUnderlying <= _tokenUnderlying.balanceOf(fund),
            "Not enough underlying in fund"
        );
        claimableUnderlying = claimableUnderlying.add(requiredUnderlying);
        IFundForPrimaryMarketV4(fund).primaryMarketPayDebt(requiredUnderlying);
        redemptionQueueHead = newHead;
        emit RedemptionPopped(newHead - oldHead, newHead, requiredUnderlying);
    }

    /// @notice Claim underlying tokens of queued redemptions. All these redemptions must belong
    ///         to msg.sender.
    /// @param indices Indices of the redemptions in the queue, which must be in increasing order
    /// @param rateIndices Indices of the redemption rates, which must corrspond to the queued
    ///        redemption indices
    /// @param rateIndexOfHead Redemption rate index of the first redemption in the queue
    ///        (index `redemptionQueueHead`). Call `getRedemptionRateIndexOfHead()` for this value.
    /// @return underlying Total claimed underlying amount
    function claimRedemptions(
        uint256[] calldata indices,
        uint256[] calldata rateIndices,
        uint256 rateIndexOfHead
    ) external nonReentrant returns (uint256 underlying) {
        underlying = _claimRedemptions(indices, rateIndices, rateIndexOfHead);
        _tokenUnderlying.safeTransfer(msg.sender, underlying);
    }

    /// @notice Claim native currency of queued redemptions. The underlying must be wrapped token
    ///         of the native currency. All these redemptions must belong to msg.sender.
    /// @param indices Indices of the redemptions in the queue, which must be in increasing order
    /// @param rateIndices Indices of the redemption rates, which must corrspond to the indices
    /// @param rateIndexOfHead Redemption rate index of the first redemption in the queue
    ///        (index `redemptionQueueHead`). Call `getRedemptionRateIndexOfHead()` for this value.
    /// @return underlying Total claimed underlying amount
    function claimRedemptionsAndUnwrap(
        uint256[] calldata indices,
        uint256[] calldata rateIndices,
        uint256 rateIndexOfHead
    ) external nonReentrant returns (uint256 underlying) {
        underlying = _claimRedemptions(indices, rateIndices, rateIndexOfHead);
        IWrappedERC20(address(_tokenUnderlying)).withdraw(underlying);
        (bool success, ) = msg.sender.call{value: underlying}("");
        require(success, "Transfer failed");
    }

    function _claimRedemptions(
        uint256[] calldata indices,
        uint256[] calldata rateIndices,
        uint256 rateIndexOfHead
    ) private returns (uint256 underlying) {
        uint256 count = indices.length;
        require(count == rateIndices.length, "Invalid rate indices");
        if (count == 0) {
            return 0;
        }
        uint256 head = redemptionQueueHead;
        if (indices[count - 1] >= head) {
            _popRedemptionQueue(indices[count - 1] - head + 1, rateIndexOfHead);
        }
        for (uint256 i = 0; i < count; i++) {
            require(i == 0 || indices[i] > indices[i - 1], "Indices out of order");
            require(rateIndices[i] < redemptionRateSize, "Invalid rate index");
            // redemptionRates[rateIndices[i] - 1].nextIndex == 0 if rateIndices[i] == 0
            require(
                indices[i] < redemptionRates[rateIndices[i]].nextIndex &&
                    indices[i] >= redemptionRates[rateIndices[i] - 1].nextIndex,
                "Invalid index"
            );
            QueuedRedemption storage redemption = queuedRedemptions[indices[i]];
            uint256 redemptionUnderlying = redemption.amountQ.multiplyDecimalPrecise(
                redemptionRates[rateIndices[i]].underlyingPerQ
            );
            require(
                ownerOf(indices[i]) == msg.sender && redemption.amountQ != 0,
                "Invalid redemption index"
            );
            underlying = underlying.add(redemptionUnderlying);
            emit RedemptionClaimed(msg.sender, indices[i], redemptionUnderlying);
            delete queuedRedemptions[indices[i]];
            _burn(indices[i]);
        }
        claimableUnderlying = claimableUnderlying.sub(underlying);
    }

    function split(
        address recipient,
        uint256 inQ,
        uint256 version
    ) external returns (uint256 outB) {
        outB = getSplit(inQ);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_B, recipient, outB, version);
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_R, recipient, outB, version);
        emit Split(recipient, inQ, outB, outB);
    }

    function merge(
        address recipient,
        uint256 inB,
        uint256 version
    ) external returns (uint256 outQ) {
        uint256 feeQ;
        (outQ, feeQ) = getMerge(inB);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_B, msg.sender, inB, version);
        IFundForPrimaryMarketV4(fund).primaryMarketBurn(TRANCHE_R, msg.sender, inB, version);
        IFundForPrimaryMarketV4(fund).primaryMarketMint(TRANCHE_Q, recipient, outQ, version);
        IFundForPrimaryMarketV4(fund).primaryMarketAddDebtAndFee(0, feeQ);
        emit Merged(recipient, outQ, inB, inB, feeQ);
    }

    /// @dev Nothing to do for daily fund settlement.
    function settle(uint256 day) external onlyFund {}

    function _updateFundCap(uint256 newCap) private {
        fundCap = newCap;
        emit FundCapUpdated(newCap);
    }

    function updateFundCap(uint256 newCap) external onlyOwner {
        _updateFundCap(newCap);
    }

    function _updateMergeFeeRate(uint256 newMergeFeeRate) private {
        require(newMergeFeeRate <= MAX_MERGE_FEE_RATE, "Exceed max merge fee rate");
        mergeFeeRate = newMergeFeeRate;
        emit MergeFeeRateUpdated(newMergeFeeRate);
    }

    function updateMergeFeeRate(uint256 newMergeFeeRate) external onlyOwner {
        _updateMergeFeeRate(newMergeFeeRate);
    }

    function _updateRedemptionBounds(
        uint256 newMinRedemptionBound,
        uint256 newMaxRedemptionBound
    ) private {
        require(newMinRedemptionBound <= newMaxRedemptionBound, "Invalid redemption bounds");
        minRedemptionBound = newMinRedemptionBound;
        maxRedemptionBound = newMaxRedemptionBound;
        emit RedemptionBoundsUpdated(newMinRedemptionBound, newMaxRedemptionBound);
    }

    function updateRedemptionBounds(
        uint256 newMinRedemptionBound,
        uint256 newMaxRedemptionBound
    ) external onlyOwner {
        _updateRedemptionBounds(newMinRedemptionBound, newMaxRedemptionBound);
    }

    /// @notice Receive unwrapped transfer from the wrapped token.
    receive() external payable {}

    modifier onlyFund() {
        require(msg.sender == fund, "Only fund");
        _;
    }
}
