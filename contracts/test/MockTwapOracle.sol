// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/ITwapOracle.sol";
import "../utils/CoreUtility.sol";

contract MockTwapOracle is ITwapOracle, CoreUtility, Ownable {
    struct StoredEpoch {
        uint256 twap;
        uint256 nextEpoch;
    }

    event Update(uint256 timestamp, uint256 price, UpdateType updateType);

    uint256 private constant EPOCH = 30 minutes;
    uint256 private constant MAX_ITERATION = 500;

    ITwapOracle public immutable fallbackOracle;

    uint256 public startEpoch;

    /// @notice A linked-list of epochs when TWAP is updated.
    ///         Epochs ending at the end of trading days are always stored.
    mapping(uint256 => StoredEpoch) public storedEpochs;

    /// @notice Timestamp of the last stored epoch. The `Update` event is not emitted for
    ///         this epoch yet.
    uint256 public lastStoredEpoch;

    /// @notice Mapping of epoch => TWAP. This mapping stores epochs that are manually updated
    ///         out-of-order.
    ///
    ///         - If value is 0, the epoch is not a hole and its TWAP equals to the last stored epoch.
    ///         - If value is uint(-1), the epoch is a hole and not updated yet.
    ///         - Otherwise, the epoch is a hole and the value is its TWAP.
    mapping(uint256 => uint256) public holes;

    constructor(uint256 initialTwap, address fallbackOracle_) public {
        fallbackOracle = ITwapOracle(fallbackOracle_);
        startEpoch = _endOfDay(block.timestamp) - 1 days;
        storedEpochs[startEpoch].twap = initialTwap;
        lastStoredEpoch = startEpoch;
    }

    function updateNext(uint256 twap) external onlyOwner {
        uint256 nextEpoch = _nextEpoch();
        require(nextEpoch - lastStoredEpoch < EPOCH * MAX_ITERATION, "Call catchUp() first");
        catchUp();
        storedEpochs[nextEpoch].twap = twap;
    }

    /// @notice Emit `Update` event for past epochs and add a stored epoch for the next one.
    function catchUp() public {
        uint256 nextEpoch = _nextEpoch();
        uint256 lastEpoch = lastStoredEpoch;
        if (nextEpoch == lastEpoch) {
            return;
        }
        uint256 nextStoredEpoch = _endOfDay(lastEpoch);
        uint256 twap = storedEpochs[lastEpoch].twap;
        if (holes[lastEpoch] == 0) {
            emit Update(lastEpoch, twap, UpdateType.PRIMARY);
        }
        uint256 epoch = lastEpoch + EPOCH;
        for (uint256 i = 0; i < MAX_ITERATION && epoch < nextEpoch; i++) {
            if (holes[epoch] == 0) {
                emit Update(epoch, twap, UpdateType.PRIMARY);
                if (epoch == nextStoredEpoch) {
                    storedEpochs[lastEpoch].nextEpoch = nextStoredEpoch;
                    storedEpochs[nextStoredEpoch].twap = twap;
                    lastEpoch = nextStoredEpoch;
                    nextStoredEpoch += 1 days;
                }
            }
            epoch += EPOCH;
        }
        storedEpochs[lastEpoch].nextEpoch = nextEpoch;
        storedEpochs[nextEpoch].twap = twap;
        lastStoredEpoch = nextEpoch;
    }

    function digHole(uint256 timestamp) external onlyOwner {
        require(timestamp % EPOCH == 0, "Unaligned timestamp");
        require(timestamp > block.timestamp, "Can only dig hole in the future");
        holes[timestamp] = uint256(-1);
    }

    function fillHole(uint256 timestamp, uint256 twap) external onlyOwner {
        require(timestamp % EPOCH == 0, "Unaligned timestamp");
        require(timestamp < block.timestamp, "Can only fill hole in the past");
        require(holes[timestamp] == uint256(-1), "Not a hole or already filled");
        holes[timestamp] = twap;
        emit Update(timestamp, twap, UpdateType.OWNER);
    }

    function getTwap(uint256 timestamp) external view override returns (uint256) {
        if (timestamp < startEpoch) {
            if (address(fallbackOracle) == address(0)) {
                return 0;
            } else {
                return fallbackOracle.getTwap(timestamp);
            }
        }
        if (timestamp >= block.timestamp || timestamp % EPOCH != 0) {
            return 0;
        }

        uint256 holeTwap = holes[timestamp];
        if (holeTwap != 0) {
            return holeTwap == uint256(-1) ? 0 : holeTwap;
        }

        uint256 epoch = lastStoredEpoch;
        if (epoch > timestamp) {
            // Search for the nearest stored epoch. The search starts at the latest 00:00 UTC
            // no later than the given timestamp, which is guaranteed to be a stored epoch.
            epoch = _endOfDay(timestamp) - 1 days;
        }
        uint256 next = storedEpochs[epoch].nextEpoch;
        while (next > 0 && next <= timestamp) {
            epoch = next;
            next = storedEpochs[epoch].nextEpoch;
        }
        return storedEpochs[epoch].twap;
    }

    function _endOfDay(uint256 timestamp) private pure returns (uint256) {
        return ((timestamp.add(1 days) - SETTLEMENT_TIME) / 1 days) * 1 days + SETTLEMENT_TIME;
    }

    function _nextEpoch() private view returns (uint256) {
        return (block.timestamp / EPOCH) * EPOCH + EPOCH;
    }
}
