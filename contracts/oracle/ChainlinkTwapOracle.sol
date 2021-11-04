// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV2V3Interface.sol";
import "@uniswap/v2-periphery/contracts/libraries/UniswapV2OracleLibrary.sol";
import "@uniswap/lib/contracts/libraries/FixedPoint.sol";

import "../interfaces/ITwapOracle.sol";

/// @title Time-weighted average price oracle
/// @notice This contract extends the Chainlink Oracle, computes
///         time-weighted average price (TWAP) in every 30-minute epoch.
/// @author Tranchess

interface IAggregatorProxy is AggregatorV2V3Interface {
    /**
     * @notice returns the current phase's ID.
     */
    function phaseId() external view returns (uint16);
}

struct Observation {
    uint256 timestamp;
    uint256 cumulative;
}

contract ChainlinkTwapOracle is ITwapOracle, Ownable {
    using FixedPoint for *;
    using SafeMath for *;

    uint256 private constant EPOCH = 30 minutes;
    uint256 private constant PUBLISHING_DELAY = 2 minutes;
    uint256 private constant MIN_MESSAGE_COUNT = 10;
    uint256 private constant SWAP_DELAY = EPOCH * 2;
    uint256 private constant MAX_ITERATION = 500;

    event Update(uint256 timestamp, uint256 price, UpdateType updateType);

    IAggregatorProxy public immutable chainlinkAggregator;
    uint256 private immutable _chainlinkAggregatorPricePrecision;

    address public immutable swapPair;
    mapping(uint256 => Observation) public observations;

    string public symbol;

    uint16 public currentPhaseID;
    uint80 public currentRoundID;
    uint256 public currentTimestamp;

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
        chainlinkAggregator = IAggregatorProxy(chainlinkAggregator_);
        swapPair = swapPair_;
        symbol = symbol_;
        uint256 decimal = IAggregatorProxy(chainlinkAggregator_).decimals();
        _chainlinkAggregatorPricePrecision = 10**(18.sub(decimal));
        currentPhaseID = IAggregatorProxy(chainlinkAggregator_).phaseId();
        uint256 updatedAt;
        (currentRoundID, , , updatedAt, ) = IAggregatorProxy(chainlinkAggregator_)
            .latestRoundData();
        currentTimestamp = (updatedAt / EPOCH) * EPOCH + EPOCH;

        // updateCumulativeFromSwap
        (, uint256 priceCumulative, uint32 blockTimestamp) =
            UniswapV2OracleLibrary.currentCumulativePrices(swapPair_);
        uint256 epoch = (blockTimestamp / EPOCH) * EPOCH + EPOCH;
        observations[epoch].timestamp = blockTimestamp;
        observations[epoch].cumulative = priceCumulative;
    }

    /// @notice Return TWAP with 18 decimal places in the epoch ending at the specified timestamp.
    ///         Zero is returned if the epoch is not initialized yet.
    /// @param timestamp End Timestamp in seconds of the epoch
    /// @return TWAP (18 decimal places) in the epoch, or zero if the epoch is not initialized yet.
    function getTwap(uint256 timestamp) external view override returns (uint256) {
        (uint80 latestRoundID, , , uint256 updatedAt, ) = chainlinkAggregator.latestRoundData();
        if (timestamp > block.timestamp - PUBLISHING_DELAY) {
            return 0;
        }
        uint256 price = _prices[timestamp];
        if (price != 0) return price;

        // Chainlink
        if (updatedAt >= timestamp) {
            uint16 phaseID = chainlinkAggregator.phaseId();
            if (phaseID == currentPhaseID) {
                uint80 roundID = nearestRoundID(latestRoundID, timestamp.sub(EPOCH)) + 1;
                (uint256 average, uint256 nextRoundID) = _getChainlinkTwap(roundID, timestamp);
                if (nextRoundID != 0) return average;
            }
        }

        // Swap
        Observation memory startObservation = observations[timestamp.sub(EPOCH)];
        Observation memory endObservation = observations[timestamp];
        if (startObservation.cumulative != 0 && endObservation.cumulative != 0) {
            return _getSwapTwap(startObservation, endObservation);
        }
        return 0;
    }

    function update() external {
        updateTwapFromChainlink();
        updateCumulativeFromSwap();
    }

    /// @dev Sequentially update TWAP oracle with Chainlink oracle
    function updateTwapFromChainlink() public {
        uint256 timestamp = currentTimestamp;
        uint80 roundID = currentRoundID;
        uint16 phaseID = chainlinkAggregator.phaseId();
        (uint80 latestRoundID, , , uint256 updatedAt, ) = chainlinkAggregator.latestRoundData();
        if (phaseID != currentPhaseID || latestRoundID <= roundID || updatedAt < timestamp) {
            return;
        }

        (, , , updatedAt, ) = chainlinkAggregator.getRoundData(roundID - 1);
        uint256 startTimestamp = timestamp.sub(EPOCH);
        // Binary search for the start round ID if twap has been updated by oracles other than chainlink
        if (updatedAt + EPOCH < startTimestamp) {
            roundID = nearestRoundID(latestRoundID, startTimestamp) + 1;
        }
        (uint256 average, uint80 nextRoundID) = _getChainlinkTwap(roundID, timestamp);
        if (nextRoundID == 0) return;
        if (_prices[timestamp] == 0) {
            _prices[timestamp] = average;
            emit Update(timestamp, average, UpdateType.CHAINLINK);
        }
        timestamp += EPOCH;
        currentTimestamp = timestamp;
        currentRoundID = nextRoundID;
    }

    function updateCumulativeFromSwap() public {
        (, uint256 priceCumulative, uint32 blockTimestamp) =
            UniswapV2OracleLibrary.currentCumulativePrices(swapPair);
        uint256 epoch = (blockTimestamp / EPOCH) * EPOCH + EPOCH;
        observations[epoch].timestamp = blockTimestamp;
        observations[epoch].cumulative = priceCumulative;
    }

    /// @dev Sequentially update TWAP oracle with Swap oracle
    function updateTwapFromSwap() external {
        uint256 timestamp = currentTimestamp;
        Observation memory startObservation = observations[timestamp.sub(EPOCH)];
        Observation memory endObservation = observations[timestamp];
        // If the interval between two epochs is less than one epoch, look one epoch further
        if (endObservation.timestamp.sub(startObservation.timestamp) < EPOCH) {
            startObservation = observations[timestamp.sub(EPOCH * 2)];
        }
        require(
            _prices[timestamp] == 0 && timestamp < block.timestamp - SWAP_DELAY,
            "Not yet for swap"
        );
        require(
            startObservation.cumulative != 0 && endObservation.cumulative != 0,
            "Missing swap data"
        );

        uint256 average = _getSwapTwap(startObservation, endObservation);
        _prices[timestamp] = average;
        emit Update(timestamp, average, UpdateType.SWAP);
        currentTimestamp = timestamp + EPOCH;
    }

    function _getChainlinkTwap(uint80 roundID, uint256 endTimestamp)
        private
        view
        returns (uint256 average, uint80 nextRoundID)
    {
        require(endTimestamp % EPOCH == 0, "Unaligned endTimestamp");
        uint256 sum;
        (, int256 answer, , uint256 updatedAt, ) = chainlinkAggregator.getRoundData(roundID);
        uint256 messageCount = 0;
        for (; messageCount < MAX_ITERATION && updatedAt < endTimestamp; messageCount++) {
            sum += uint256(answer);
            (, answer, , updatedAt, ) = chainlinkAggregator.getRoundData(++roundID);
        }
        // Return zeros if not enough data points within the interval
        if (messageCount < MIN_MESSAGE_COUNT) {
            return (0, 0);
        }
        average = (sum * _chainlinkAggregatorPricePrecision) / messageCount;
        nextRoundID = roundID;
    }

    function _getSwapTwap(Observation memory startObservation, Observation memory endObservation)
        private
        pure
        returns (uint256)
    {
        return
            FixedPoint
                .uq112x112(
                uint224(
                    (endObservation.cumulative.sub(startObservation.cumulative)) /
                        (endObservation.timestamp.sub(startObservation.timestamp))
                )
            )
                .mul(1e18)
                .decode144();
    }

    /// @dev Binary search for the clostest roundID that's less than endTimestamp
    function nearestRoundID(uint80 latestRoundID, uint256 endTimestamp)
        public
        view
        returns (uint80 targetRoundID)
    {
        uint80 startRoundID = currentRoundID;
        targetRoundID = startRoundID - 1;
        while (startRoundID <= latestRoundID) {
            uint80 midRoundID = (startRoundID + latestRoundID) / 2;
            (, , , uint256 updatedAt, ) = chainlinkAggregator.getRoundData(midRoundID);
            if (updatedAt >= endTimestamp) {
                latestRoundID = midRoundID - 1;
            } else {
                targetRoundID = midRoundID;
                startRoundID = midRoundID + 1;
            }
        }
        return targetRoundID;
    }
}
