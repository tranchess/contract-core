// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

/// @notice A mock aggregator that simulates rounds at a fixed interval.
contract MockChainlinkAggregator is Ownable, AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint80 nextRoundID;
    }

    uint256 public constant ROUND = 60;

    uint80 private constant RECORD_INTERVAL = 50000;

    uint256 public constant override version = 1;

    uint8 public override decimals;

    string public override description;

    uint256 public startTimestamp;

    mapping(uint80 => Round) public rounds;

    uint80 lastRecordedID;

    constructor(uint8 decimals_) public {
        decimals = decimals_;
        description = "Mock Chainlink Aggregator";
        startTimestamp = (block.timestamp / 1 days) * 1 days;
    }

    function update(int256 answer) external onlyOwner {
        uint80 nextID = latestRoundID() + 1;
        uint80 lastID = lastRecordedID;
        uint80 missingID = (lastID / RECORD_INTERVAL) * RECORD_INTERVAL + RECORD_INTERVAL;
        int256 lastAnswer = rounds[lastID].answer;
        while (missingID < nextID) {
            rounds[lastID].nextRoundID = missingID;
            rounds[missingID].answer = lastAnswer;
            lastID = missingID;
            missingID += RECORD_INTERVAL;
        }
        rounds[lastID].nextRoundID = nextID;
        rounds[nextID].answer = answer;
    }

    function getRoundData(uint80 _roundID)
        public
        view
        override
        returns (
            uint80,
            int256,
            uint256,
            uint256,
            uint80
        )
    {
        // Search for the latest round no later than the requested round ID
        // and return its answer. The search starts at a multiple of RECORD_INTERVAL,
        // which is guaranteed to be an existing recorded round ID.
        uint80 id = (_roundID / RECORD_INTERVAL) * RECORD_INTERVAL;
        Round memory round = rounds[id];
        while (round.nextRoundID <= _roundID && round.nextRoundID > 0) {
            round = rounds[round.nextRoundID];
        }
        uint256 timestamp = roundTimestamp(_roundID);
        return (_roundID, round.answer, timestamp, timestamp, _roundID);
    }

    function latestRoundData()
        external
        view
        override
        returns (
            uint80,
            int256,
            uint256,
            uint256,
            uint80
        )
    {
        return getRoundData(latestRoundID());
    }

    function latestRoundID() public view returns (uint80) {
        return uint80((block.timestamp - startTimestamp) / ROUND);
    }

    function roundTimestamp(uint80 roundID) public view returns (uint256) {
        return startTimestamp + roundID * ROUND;
    }
}
