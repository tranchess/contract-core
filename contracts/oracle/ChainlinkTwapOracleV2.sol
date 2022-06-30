// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

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
contract ChainlinkTwapOracleV2 is ITwapOracleV2, Ownable {
    using SafeMath for uint256;

    uint256 private constant EPOCH = 30 minutes;
    uint256 private constant MAX_ITERATION = 500;

    event Update(uint256 timestamp, uint256 price, UpdateType updateType);

    /// @notice Chainlink aggregator used as the primary data source.
    address public immutable chainlinkAggregator;

    /// @notice Minimum number of Chainlink rounds required in an epoch.
    uint256 public immutable chainlinkMinMessageCount;

    /// @dev A multipler that normalizes price from the Chainlink aggregator to 18 decimal places.
    uint256 private immutable _chainlinkPriceMultiplier;

    /// @notice The previous oracle that was used before this contract is deployed.
    ITwapOracle public immutable fallbackOracle;

    /// @notice Epochs until this timestamp should be read from the fallback oracle.
    uint256 public immutable fallbackTimestamp;

    string public symbol;

    /// @notice The latest Chainlink round ID at the beginning.
    uint80 public immutable startRoundID;

    /// @dev Mapping of epoch end timestamp => TWAP
    mapping(uint256 => uint256) private _prices;

    constructor(
        address chainlinkAggregator_,
        uint256 chainlinkMinMessageCount_,
        address fallbackOracle_,
        uint256 fallbackTimestamp_,
        string memory symbol_
    ) public {
        chainlinkAggregator = chainlinkAggregator_;
        chainlinkMinMessageCount = chainlinkMinMessageCount_;
        uint256 decimal = AggregatorV3Interface(chainlinkAggregator_).decimals();
        _chainlinkPriceMultiplier = 10**(uint256(18).sub(decimal));

        fallbackOracle = ITwapOracle(fallbackOracle_);
        symbol = symbol_;
        uint256 lastTimestamp = (block.timestamp / EPOCH) * EPOCH + EPOCH;
        require(
            fallbackOracle_ == address(0) || fallbackTimestamp_ >= lastTimestamp,
            "Fallback timestamp too early"
        );
        fallbackTimestamp = fallbackTimestamp_;
        (startRoundID, , , , ) = AggregatorV3Interface(chainlinkAggregator_).latestRoundData();
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
            if (_prices[timestamp] != 0) {
                return _prices[timestamp];
            } else {
                uint256 epochEnd = ((timestamp + EPOCH - 1) / EPOCH) * EPOCH;
                uint256 chainlinkTwap = _updateTwapFromChainlink(epochEnd);
                return chainlinkTwap;
            }
        }
    }

    /// @notice Attempt to update the given epoch of `timestamp` using data from Chainlink.
    function update(uint256 timestamp) external {
        uint256 epochEnd = ((timestamp + EPOCH - 1) / EPOCH) * EPOCH;
        uint256 chainlinkTwap = _updateTwapFromChainlink(epochEnd);

        if (chainlinkTwap != 0) {
            _prices[timestamp] = chainlinkTwap;
            emit Update(timestamp, chainlinkTwap, UpdateType.CHAINLINK);
        }
    }

    /// @dev Sequentially read Chainlink oracle until end of the given epoch.
    /// @param timestamp End timestamp of the epoch to be updated
    /// @return twap TWAP of the epoch calculated from Chainlink, or zero if there's no sufficient data
    function _updateTwapFromChainlink(uint256 timestamp) private view returns (uint256 twap) {
        require(block.timestamp > timestamp, "Too soon");
        (uint80 latestRoundID, , , , ) =
            AggregatorV3Interface(chainlinkAggregator).latestRoundData();
        uint80 epochStartRoundID = nearestRoundID(startRoundID, latestRoundID, timestamp - EPOCH);

        (uint80 roundID, int256 oldAnswer, , uint256 oldUpdatedAt, ) =
            _getChainlinkRoundData(epochStartRoundID);
        uint256 sum = 0;
        uint256 sumTimestamp = timestamp - EPOCH;
        uint256 messageCount = 0;
        for (uint256 i = 0; i < MAX_ITERATION; i++) {
            (, int256 newAnswer, , uint256 newUpdatedAt, ) = _getChainlinkRoundData(++roundID);
            if (newUpdatedAt < oldUpdatedAt || newUpdatedAt > timestamp) {
                // This round is either not available yet (newUpdatedAt < updatedAt)
                // or beyond the current epoch (newUpdatedAt > timestamp).
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
            return sum.mul(_chainlinkPriceMultiplier) / EPOCH;
        } else {
            return 0;
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

    /// @notice Submit a TWAP with 18 decimal places by the owner.
    ///         This is allowed only when a epoch cannot be updated by either Chainlink or Uniswap.
    function updateTwapFromOwner(uint256 timestamp, uint256 price) external onlyOwner {
        require(timestamp % EPOCH == 0, "Unaligned timestamp");
        require(_prices[timestamp] == 0, "Owner cannot update an existing epoch");

        uint256 chainlinkTwap = _updateTwapFromChainlink(timestamp);
        require(chainlinkTwap == 0, "Owner cannot overwrite Chainlink result");

        _prices[timestamp] = price;
        emit Update(timestamp, price, UpdateType.OWNER);
    }

    /// @dev Binary search for the clostest roundID that's less than endTimestamp
    function nearestRoundID(
        uint80 start,
        uint80 end,
        uint256 endTimestamp
    ) public view returns (uint80 targetRoundID) {
        while (start <= end) {
            uint80 mid = (start + end) / 2;
            (, , , uint256 updatedAt, ) = _getChainlinkRoundData(mid);
            if (updatedAt >= endTimestamp) {
                end = mid - 1;
            } else {
                targetRoundID = mid;
                start = mid + 1;
            }
        }
    }
}
