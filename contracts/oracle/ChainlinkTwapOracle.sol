// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";
import "@uniswap/v2-periphery/contracts/libraries/UniswapV2OracleLibrary.sol";
import "@uniswap/lib/contracts/libraries/FixedPoint.sol";

import "../interfaces/ITwapOracleV2.sol";

/// @title Time-weighted average price oracle
/// @notice This contract extends the Chainlink Oracle, computes
///         time-weighted average price (TWAP) in every 30-minute epoch.
/// @author Tranchess
/// @dev This contract relies on the following assumptions on the Chainlink aggregator:
///      1. Round ID returned by `latestRoundData()` is monotonically increasing over time.
///      2. Round ID is continuous in the same phase. Formally speaking, let `x` and `y` be two
///         round IDs returned by `latestRoundData` in different blocks and they satisfy `x < y`
///         and `x >> 64 == y >> 64`. Then every integer between `x` and `y` is a valid round ID.
///      3. Phase change is rare.
///      4. Each round is updated only once and `updatedAt` returned by `getRoundData()` is
///         timestamp of the block in which the round is updated. Therefore, a transaction is
///         guaranteed to see all rounds whose `updatedAt` is less than the current block timestamp.
contract ChainlinkTwapOracle is ITwapOracleV2, Ownable {
    using FixedPoint for FixedPoint.uq112x112;
    using FixedPoint for FixedPoint.uq144x112;
    using SafeMath for uint256;

    uint256 private constant EPOCH = 30 minutes;
    uint256 private constant MAX_SWAP_DELAY = 15 minutes;
    uint256 private constant MAX_ITERATION = 500;

    event Update(uint256 timestamp, uint256 price, UpdateType updateType);

    /// @notice The contract fails to update an epoch from either Chainlink or Uniswap
    ///         and will not attempt to do so in the future.
    event SkipMissingData(uint256 timestamp);

    /// @notice Twap of this epoch can be calculated from both Chainlink and Uniswap,
    ///         but the difference is too large. The contract decides not to update this epoch
    ///         using either result.
    event SkipDeviation(uint256 timestamp, uint256 chainlinkTwap, uint256 swapTwap);

    /// @notice Chainlink aggregator used as the primary data source.
    address public immutable chainlinkAggregator;

    /// @notice Minimum number of Chainlink rounds required in an epoch.
    uint256 public immutable chainlinkMinMessageCount;

    /// @dev A multipler that normalizes price from the Chainlink aggregator to 18 decimal places.
    uint256 private immutable _chainlinkPriceMultiplier;

    /// @notice Uniswap V2 pair contract used as the backup data source.
    address public immutable swapPair;

    /// @dev Index of the token (0 or 1) in the pair whose price is taken.
    uint256 private immutable _swapTokenIndex;

    /// @dev A multipler that normalizes price from the Uniswap V2 pair to 18 decimal places.
    uint256 private immutable _swapPriceMultiplier;

    /// @notice The previous oracle that was used before this contract is deployed.
    ITwapOracle public immutable fallbackOracle;

    /// @notice Epochs until this timestamp should be read from the fallback oracle.
    uint256 public immutable fallbackTimestamp;

    string public symbol;

    /// @notice The last epoch that has been updated (or attempted to update) using data from
    ///         Chainlink or Uniswap.
    uint256 public lastTimestamp;

    /// @notice The last Chainlink round ID that has been read.
    uint80 public lastRoundID;

    /// @notice The last observation of the Uniswap V2 pair cumulative price.
    uint256 public lastSwapCumulativePrice;

    /// @notice Timestamp of the last Uniswap observation.
    uint256 public lastSwapTimestamp;

    /// @dev Mapping of epoch end timestamp => TWAP
    mapping(uint256 => uint256) private _prices;

    /// @param chainlinkAggregator_ Address of the Chainlink aggregator
    /// @param swapPair_ Address of the Uniswap V2 pair
    /// @param symbol_ Asset symbol
    constructor(
        address chainlinkAggregator_,
        uint256 chainlinkMinMessageCount_,
        address swapPair_,
        address fallbackOracle_,
        uint256 fallbackTimestamp_,
        string memory symbol_
    ) public {
        chainlinkAggregator = chainlinkAggregator_;
        chainlinkMinMessageCount = chainlinkMinMessageCount_;
        uint256 decimal = AggregatorV3Interface(chainlinkAggregator_).decimals();
        _chainlinkPriceMultiplier = 10**(uint256(18).sub(decimal));

        swapPair = swapPair_;
        ERC20 swapToken0 = ERC20(IUniswapV2Pair(swapPair_).token0());
        ERC20 swapToken1 = ERC20(IUniswapV2Pair(swapPair_).token1());
        uint256 swapTokenIndex_;
        bytes32 symbolHash = keccak256(bytes(symbol_));
        if (symbolHash == keccak256(bytes(swapToken0.symbol()))) {
            swapTokenIndex_ = 0;
        } else if (symbolHash == keccak256(bytes(swapToken1.symbol()))) {
            swapTokenIndex_ = 1;
        } else {
            revert("Symbol mismatch");
        }
        _swapTokenIndex = swapTokenIndex_;
        _swapPriceMultiplier = swapTokenIndex_ == 0
            ? 10**(uint256(18).add(swapToken0.decimals()).sub(swapToken1.decimals()))
            : 10**(uint256(18).add(swapToken1.decimals()).sub(swapToken0.decimals()));

        fallbackOracle = ITwapOracle(fallbackOracle_);
        symbol = symbol_;
        lastTimestamp = (block.timestamp / EPOCH) * EPOCH + EPOCH;
        require(
            fallbackOracle_ == address(0) || fallbackTimestamp_ >= lastTimestamp,
            "Fallback timestamp too early"
        );
        fallbackTimestamp = fallbackTimestamp_;
        (lastRoundID, , , , ) = AggregatorV3Interface(chainlinkAggregator_).latestRoundData();
    }

    /// @notice Return the latest price with 18 decimal places.
    function getLatest() external view override returns (uint256) {
        (, int256 answer, , uint256 updatedAt, ) =
            AggregatorV3Interface(chainlinkAggregator).latestRoundData();
        require(updatedAt > block.timestamp - EPOCH, "Stale price oracle");
        return uint256(answer).mul(_chainlinkPriceMultiplier);
    }

    /// @notice Return TWAP with 18 decimal places in the epoch ending at the specified timestamp.
    ///         Zero is returned if the epoch is not initialized yet.
    /// @param timestamp End Timestamp in seconds of the epoch
    /// @return TWAP (18 decimal places) in the epoch, or zero if the epoch is not initialized yet.
    function getTwap(uint256 timestamp) external view override returns (uint256) {
        if (timestamp <= fallbackTimestamp) {
            return address(fallbackOracle) == address(0) ? 0 : fallbackOracle.getTwap(timestamp);
        } else {
            return _prices[timestamp];
        }
    }

    /// @notice Attempt to update the next epoch after `lastTimestamp` using data from Chainlink
    ///         or Uniswap. If neither data source is available, the epoch is skipped and this
    ///         function will never update it in the future.
    ///
    ///         This function is designed to be called after each epoch.
    /// @dev First, this function reads all Chainlink rounds before the end of this epoch, and
    ///      calculates the TWAP if there are enough data points in this epoch.
    ///
    ///      Otherwise, it tries to use data from Uniswap. Calculating TWAP from a Uniswap pair
    ///      requires two observations at both endpoints of the epoch. An observation is considered
    ///      valid only if it's taken within `MAX_SWAP_DELAY` seconds after the desired timestamp.
    ///      Regardless of whether or how the epoch is updated, the current observation is stored
    ///      if it is valid for the next epoch's start.
    function update() external {
        uint256 timestamp = lastTimestamp + EPOCH;
        require(block.timestamp > timestamp, "Too soon");

        (uint256 chainlinkTwap, uint80 newRoundID) = _updateTwapFromChainlink(timestamp);

        // Only observe the Uniswap pair if it's not too late.
        uint256 swapTwap = 0;
        if (block.timestamp <= timestamp + MAX_SWAP_DELAY) {
            uint256 currentCumulativePrice = _observeSwap();
            swapTwap = _updateTwapFromSwap(timestamp, currentCumulativePrice);
            lastSwapCumulativePrice = currentCumulativePrice;
            lastSwapTimestamp = block.timestamp;
        }

        if (chainlinkTwap != 0) {
            if (
                swapTwap != 0 &&
                (chainlinkTwap < (swapTwap / 10) * 9 || swapTwap < (chainlinkTwap / 10) * 9)
            ) {
                emit SkipDeviation(timestamp, chainlinkTwap, swapTwap);
            } else {
                _prices[timestamp] = chainlinkTwap;
                emit Update(timestamp, chainlinkTwap, UpdateType.CHAINLINK);
            }
        } else if (swapTwap != 0) {
            _prices[timestamp] = swapTwap;
            emit Update(timestamp, swapTwap, UpdateType.UNISWAP_V2);
        } else {
            emit SkipMissingData(timestamp);
        }
        lastTimestamp = timestamp;
        lastRoundID = newRoundID;
    }

    /// @dev Sequentially read Chainlink oracle until end of the given epoch.
    /// @param timestamp End timestamp of the epoch to be updated
    /// @return twap TWAP of the epoch calculated from Chainlink, or zero if there's no sufficient data
    /// @return newRoundID The last round ID that has been read until the end of this epoch
    function _updateTwapFromChainlink(uint256 timestamp)
        private
        view
        returns (uint256 twap, uint80 newRoundID)
    {
        (uint80 roundID, int256 oldAnswer, , uint256 oldUpdatedAt, ) =
            _getChainlinkRoundData(lastRoundID);
        uint256 sum = 0;
        uint256 sumTimestamp = timestamp - EPOCH;
        uint256 messageCount = 0;
        for (uint256 i = 0; i < MAX_ITERATION; i++) {
            (, int256 newAnswer, , uint256 newUpdatedAt, ) = _getChainlinkRoundData(++roundID);
            if (newUpdatedAt < oldUpdatedAt || newUpdatedAt > timestamp) {
                // This round is either not available yet (newUpdatedAt < updatedAt)
                // or beyond the current epoch (newUpdatedAt > timestamp).
                roundID--;
                break;
            }
            if (newUpdatedAt > sumTimestamp) {
                sum = sum.add(uint256(oldAnswer).mul(newUpdatedAt - sumTimestamp));
                sumTimestamp = newUpdatedAt;
                messageCount++;
            }
            oldAnswer = newAnswer;
            oldUpdatedAt = newUpdatedAt;
        }

        if (messageCount >= chainlinkMinMessageCount) {
            sum = sum.add(uint256(oldAnswer).mul(timestamp - sumTimestamp));
            return (sum.mul(_chainlinkPriceMultiplier) / EPOCH, roundID);
        } else {
            return (0, roundID);
        }
    }

    /// @dev Calculate TWAP for the given epoch.
    /// @param timestamp End timestamp of the epoch to be updated
    /// @param currentCumulativePrice Current observation of the Uniswap pair
    /// @return TWAP of the epoch calculated from Uniswap, or zero if either observation is invalid
    function _updateTwapFromSwap(uint256 timestamp, uint256 currentCumulativePrice)
        private
        view
        returns (uint256)
    {
        uint256 t = lastSwapTimestamp;
        if (t <= timestamp - EPOCH || t > timestamp - EPOCH + MAX_SWAP_DELAY) {
            // The last observation is not taken near the start of this epoch and cannot be used
            // to update this epoch.
            return 0;
        } else {
            return
                _getSwapTwap(lastSwapCumulativePrice, currentCumulativePrice, t, block.timestamp);
        }
    }

    /// @dev Call `chainlinkAggregator.getRoundData(roundID)`. Return zero if the call reverts.
    function _getChainlinkRoundData(uint80 roundID)
        private
        view
        returns (
            uint80,
            int256,
            uint256,
            uint256,
            uint80
        )
    {
        (bool success, bytes memory returnData) =
            chainlinkAggregator.staticcall(
                abi.encodePacked(AggregatorV3Interface.getRoundData.selector, abi.encode(roundID))
            );
        if (success) {
            return abi.decode(returnData, (uint80, int256, uint256, uint256, uint80));
        } else {
            return (roundID, 0, 0, 0, roundID);
        }
    }

    function _observeSwap() private view returns (uint256) {
        (uint256 price0Cumulative, uint256 price1Cumulative, ) =
            UniswapV2OracleLibrary.currentCumulativePrices(swapPair);
        return _swapTokenIndex == 0 ? price0Cumulative : price1Cumulative;
    }

    function _getSwapTwap(
        uint256 startCumulativePrice,
        uint256 endCumulativePrice,
        uint256 startTimestamp,
        uint256 endTimestamp
    ) private view returns (uint256) {
        return
            FixedPoint
                .uq112x112(
                uint224(
                    (endCumulativePrice - startCumulativePrice) / (endTimestamp - startTimestamp)
                )
            )
                .mul(_swapPriceMultiplier)
                .decode144();
    }

    /// @notice Fast-forward Chainlink round ID by owner. This is required when `lastRoundID` stucks
    ///         at an old round, due to either incontinuous round IDs caused by a phase change or
    ///         an abnormal `updatedAt` timestamp.
    function fastForwardRoundID(uint80 roundID) external onlyOwner {
        uint80 lastRoundID_ = lastRoundID;
        require(roundID > lastRoundID_, "Round ID too low");
        (, , , uint256 lastUpdatedAt, ) = _getChainlinkRoundData(lastRoundID_);
        (, , , uint256 updatedAt, ) = _getChainlinkRoundData(roundID);
        require(updatedAt > lastUpdatedAt, "Invalid round timestamp");
        require(updatedAt <= lastTimestamp, "Round too new");
        lastRoundID = roundID;
    }

    /// @notice Submit a TWAP with 18 decimal places by the owner.
    ///         This is allowed only when a epoch cannot be updated by either Chainlink or Uniswap.
    function updateTwapFromOwner(uint256 timestamp, uint256 price) external onlyOwner {
        require(timestamp % EPOCH == 0, "Unaligned timestamp");
        require(timestamp <= lastTimestamp, "Not ready for owner");
        require(_prices[timestamp] == 0, "Owner cannot update an existing epoch");

        uint256 lastPrice = _prices[timestamp - EPOCH];
        require(lastPrice > 0, "Owner can only update a epoch following an updated epoch");
        require(
            price > lastPrice / 10 && price < lastPrice * 10,
            "Owner price deviates too much from the last price"
        );

        _prices[timestamp] = price;
        emit Update(timestamp, price, UpdateType.OWNER);
    }

    /// @notice Observe the Uniswap pair and calculate TWAP since the last observation.
    function peekSwapPrice() external view returns (uint256) {
        uint256 cumulativePrice = _observeSwap();
        return
            _getSwapTwap(
                lastSwapCumulativePrice,
                cumulativePrice,
                lastSwapTimestamp,
                block.timestamp
            );
    }
}
