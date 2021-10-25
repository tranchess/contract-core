// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV2V3Interface.sol";
import "../interfaces/ITwapOracle.sol";

/// @title Time-weighted average price oracle
/// @notice This contract extends the Chainlink Oracle, computes
///         time-weighted average price (TWAP) in every 30-minute epoch.
/// @author Tranchess
contract ChainlinkTwapOracle is ITwapOracle, Ownable {
    uint256 private constant EPOCH = 30 minutes;

    uint256 private constant SECONDARY_SOURCE_DELAY = EPOCH * 2;
    uint256 private constant OWNER_DELAY = EPOCH * 4;

    enum UpdateType {PRIMARY, SECONDARY, OWNER}

    event Update(uint256 timestamp, uint256 price, UpdateType updateType);

    AggregatorV2V3Interface public immutable primarySource;
    uint256 private immutable _primarySourcePriceUnit;
    address public immutable secondarySource;
    uint256 private immutable _startTimestamp;
    string public symbol;

    uint80 private _startRoundID;

    /// @dev Mapping of epoch end timestamp => TWAP
    mapping(uint256 => uint256) private _prices;

    /// @param primarySource_ Address of the primary data source
    /// @param secondarySource_ Address of the secondary data source
    /// @param symbol_ Asset symbol
    constructor(
        address primarySource_,
        address secondarySource_,
        string memory symbol_
    ) public {
        primarySource = AggregatorV2V3Interface(primarySource_);
        secondarySource = secondarySource_;
        symbol = symbol_;
        _startTimestamp = block.timestamp;
        uint256 decimal = AggregatorV2V3Interface(primarySource_).decimals();
        require(decimal <= 18);
        _primarySourcePriceUnit = 18 - decimal;
        (_startRoundID, , , , ) = AggregatorV2V3Interface(primarySource_).latestRoundData();
    }

    /// @notice Return TWAP with 18 decimal places in the epoch ending at the specified timestamp.
    ///         Zero is returned if the epoch is not initialized yet or can still be updated
    ///         with more messages from the same source.
    /// @param timestamp End Timestamp in seconds of the epoch
    /// @return TWAP (18 decimal places) in the epoch, or zero if the epoch is not initialized yet
    ///         or can still be updated with more messages from the same source.
    function getTwap(uint256 timestamp) external view override returns (uint256) {
        (uint80 roundID, , , uint256 updatedAt, ) = primarySource.latestRoundData();
        if (updatedAt < timestamp) {
            return 0;
        }
        return _updateTwapFromSource(roundID, timestamp);
    }

    function updateTwapFromPrimary(uint256 timestamp) external {
        (uint80 roundID, , , uint256 updatedAt, ) = primarySource.latestRoundData();
        if (updatedAt < timestamp) {
            return;
        }
        uint256 average = _updateTwapFromSource(roundID, timestamp);
        uint256 startTimestamp = timestamp - EPOCH;
        _prices[startTimestamp] = average;
        emit Update(startTimestamp, average, UpdateType.PRIMARY);
    }

    function _updateTwapFromSource(uint80 roundID, uint256 endTimestamp)
        private
        view
        returns (uint256 average)
    {
        require(endTimestamp % EPOCH == 0, "Unaligned endTimestamp");
        uint80 endRoundID = nearestRoundID(roundID, endTimestamp);
        uint256 startTimestamp = endTimestamp - EPOCH;
        uint256 sum;
        (, int256 answer, , uint256 updatedAt, ) = primarySource.getRoundData(endRoundID);
        uint256 messageCount = 0;
        for (; messageCount < 60 && updatedAt >= startTimestamp; messageCount++) {
            sum += uint256(answer);
            (, answer, , updatedAt, ) = primarySource.getRoundData(--endRoundID);
        }
        if (messageCount > 0) {
            average = (sum * _primarySourcePriceUnit) / messageCount;
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
            (, , , uint256 updatedAt, ) = primarySource.getRoundData(nextRoundID);
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
