// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV2V3Interface.sol";
import "@uniswap/v2-periphery/contracts/libraries/UniswapV2OracleLibrary.sol";
import "@uniswap/lib/contracts/libraries/FixedPoint.sol";

import "../interfaces/ITwapOracle.sol";

/// @title Time-weighted average price oracle
/// @notice This contract extends the Chainlink Oracle, computes
///         time-weighted average price (TWAP) in every 30-minute epoch.
/// @author Tranchess

struct Observation {
    uint256 timestamp;
    uint256 cumulative;
}

contract ChainlinkTwapOracle is ITwapOracle, Ownable {
    using FixedPoint for *;

    uint256 private constant EPOCH = 30 minutes;
    uint256 private constant PUBLISHING_DELAY = 2 minutes;

    enum UpdateType {CHAINLINK, SWAP, OWNER}

    event Update(uint256 timestamp, uint256 price, UpdateType updateType);

    AggregatorV2V3Interface public immutable chainlinkAggregator;
    uint256 private immutable _chainlinkAggregatorPriceUnit;

    address public immutable swapPair;
    mapping(uint256 => Observation) observations;

    uint256 private immutable _startTimestamp;
    string public symbol;

    uint80 private _startRoundID;

    /// @dev Mapping of epoch end timestamp => TWAP
    mapping(uint256 => uint256) private _prices;

    /// @param chainlinkAggregator_ Address of the chainlink aggregator
    /// @param swapPair_ Address of the swap pair
    /// @param symbol_ Asset symbol
    constructor(
        address chainlinkAggregator_,
        address swapPair_,
        string memory symbol_
    ) public {
        chainlinkAggregator = AggregatorV2V3Interface(chainlinkAggregator_);
        swapPair = swapPair_;
        symbol = symbol_;
        _startTimestamp = block.timestamp;
        uint256 decimal = AggregatorV2V3Interface(chainlinkAggregator_).decimals();
        require(decimal <= 18);
        _chainlinkAggregatorPriceUnit = 18 - decimal;
        (_startRoundID, , , , ) = AggregatorV2V3Interface(chainlinkAggregator_).latestRoundData();
    }

    /// @notice Return TWAP with 18 decimal places in the epoch ending at the specified timestamp.
    ///         Zero is returned if the epoch is not initialized yet.
    /// @param timestamp End Timestamp in seconds of the epoch
    /// @return TWAP (18 decimal places) in the epoch, or zero if the epoch is not initialized yet.
    function getTwap(uint256 timestamp) external view override returns (uint256) {
        (uint80 roundID, , , uint256 updatedAt, ) = chainlinkAggregator.latestRoundData();
        if (timestamp > block.timestamp - PUBLISHING_DELAY) {
            return 0;
        }
        uint256 price = _prices[timestamp];
        if (price != 0) {
            return price;
        }
        // Chainlink
        if (updatedAt >= timestamp) {
            return _updateTwapFromChainlink(roundID, timestamp);
        }
        // Swap
        Observation memory startObservation = observations[timestamp - EPOCH];
        Observation memory endObservation = observations[timestamp];
        if (startObservation.cumulative != 0 && endObservation.cumulative != 0) {
            // overflow is desired, casting never truncates
            // cumulative price is in (uq112x112 price * seconds) units so we simply wrap it after division by time elapsed
            return
                FixedPoint
                    .uq112x112(
                    uint224(
                        (endObservation.cumulative - startObservation.cumulative) /
                            (endObservation.timestamp - startObservation.timestamp)
                    )
                )
                    .decode();
        }
    }

    function updateTwapFromChainlink(uint256 timestamp) external {
        (uint80 roundID, , , uint256 updatedAt, ) = chainlinkAggregator.latestRoundData();
        if (updatedAt < timestamp) {
            return;
        }
        uint256 average = _updateTwapFromChainlink(roundID, timestamp);
        uint256 startTimestamp = timestamp - EPOCH;
        _prices[startTimestamp] = average;
        emit Update(startTimestamp, average, UpdateType.CHAINLINK);
    }

    function updateTwapFromSwap() public {
        (uint256 price0Cumulative, , uint32 blockTimestamp) =
            UniswapV2OracleLibrary.currentCumulativePrices(swapPair);
        uint256 epoch = blockTimestamp / EPOCH + EPOCH;
        observations[epoch].timestamp = blockTimestamp;
        observations[epoch].cumulative = price0Cumulative;
    }

    function _updateTwapFromChainlink(uint80 roundID, uint256 endTimestamp)
        private
        view
        returns (uint256 average)
    {
        require(endTimestamp % EPOCH == 0, "Unaligned endTimestamp");
        uint80 endRoundID = nearestRoundID(roundID, endTimestamp);
        uint256 startTimestamp = endTimestamp - EPOCH;
        uint256 sum;
        (, int256 answer, , uint256 updatedAt, ) = chainlinkAggregator.getRoundData(endRoundID);
        uint256 messageCount = 0;
        for (; messageCount < 60 && updatedAt >= startTimestamp; messageCount++) {
            sum += uint256(answer);
            (, answer, , updatedAt, ) = chainlinkAggregator.getRoundData(--endRoundID);
        }
        if (messageCount > 0) {
            average = (sum * _chainlinkAggregatorPriceUnit) / messageCount;
        }
    }

    /// @dev Binary search for the clostest roundID that's less than endTimestamp
    function nearestRoundID(uint80 endRoundID, uint256 endTimestamp)
        public
        view
        returns (uint80 targetRoundID)
    {
        uint80 startRoundID = _startRoundID;
        while (startRoundID <= endRoundID) {
            uint80 nextRoundID = (startRoundID + endRoundID) >> 1;
            (, , , uint256 updatedAt, ) = chainlinkAggregator.getRoundData(nextRoundID);
            if (updatedAt > endTimestamp) {
                endRoundID = nextRoundID - 1;
            } else if (updatedAt < endTimestamp) {
                targetRoundID = nextRoundID;
                startRoundID = nextRoundID + 1;
            } else {
                return startRoundID;
            }
        }
    }
}
