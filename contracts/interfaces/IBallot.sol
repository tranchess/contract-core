// SPDX-License-Identifier: MIT
pragma experimental ABIEncoderV2;
pragma solidity ^0.6.0;

interface IBallot {
    struct VotingRound {
        uint256 startTimestamp;
        uint256 endTimestamp;
        uint256 minRange;
        uint256 stepSize;
        uint256 totalVotes;
        uint256 totalValue;
        uint256 optionNumber;
    }

    // Ballot receipt record for a voter
    struct Receipt {
        uint256 lastVotedTime;
        uint256 support;
        uint256 votes;
    }

    function initialize(uint256 timestamp) external;

    function countAndUpdate(uint256 currentTimestamp) external returns (uint256 winner);

    // An event emitted when a new proposal is created
    event RoundCreated(
        address proposer,
        uint256 startBlock,
        uint256 endTimestamp,
        string description
    );
    event VoteCast(address voter, uint256 support, uint256 votes);
}
