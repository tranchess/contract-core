// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "../interfaces/IBallot.sol";
import "../interfaces/IVotingEscrow.sol";

contract InterestRateBallot is IBallot {
    using SafeMath for uint256;

    uint256 public immutable maxTime;

    uint256 public stepSize = 0.02e18;
    uint256 public minRange = 0;
    uint256 public maxOption = 3;

    IVotingEscrow public votingEscrow;

    mapping(address => Voter) public voters;

    // unlockTime => amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;
    mapping(uint256 => uint256) public scheduledWeightedUnlock;

    constructor(address votingEscrow_) public {
        votingEscrow = IVotingEscrow(votingEscrow_);
        maxTime = votingEscrow.maxTime();
    }

    function getWeight(uint256 index) public view returns (uint256) {
        uint256 delta = stepSize.mul(index);
        return minRange.add(delta);
    }

    function getReceipt(address account) external view returns (Voter memory) {
        return voters[account];
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balanceOfAtTimestamp(account, block.timestamp);
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupplyAtTimestamp(block.timestamp);
    }

    function balanceOfAtTimestamp(address account, uint256 timestamp)
        external
        view
        returns (uint256)
    {
        return _balanceOfAtTimestamp(account, timestamp);
    }

    function totalSupplyAtTimestamp(uint256 timestamp) external view returns (uint256) {
        return _totalSupplyAtTimestamp(timestamp);
    }

    function sumAtTimestamp(uint256 timestamp) external view returns (uint256) {
        return _sumAtTimestamp(timestamp);
    }

    function count(uint256 timestamp) external view override returns (uint256) {
        return _averageAtTimestamp(timestamp);
    }

    function cast(uint256 option) external {
        require(option < maxOption, "Invalid option");

        IVotingEscrow.LockedBalance memory lockedBalance =
            votingEscrow.getLockedBalance(msg.sender);
        Voter memory voter = voters[msg.sender];
        uint256 weight = getWeight(option);
        require(lockedBalance.amount > 0, "Zero value");

        // update scheduled unlock
        scheduledUnlock[voter.unlockTime] -= voter.amount;
        scheduledUnlock[lockedBalance.unlockTime] += lockedBalance.amount;

        scheduledWeightedUnlock[voter.unlockTime] -= voter.amount * voter.weight;
        scheduledWeightedUnlock[lockedBalance.unlockTime] += lockedBalance.amount * weight;

        emit Voted(
            msg.sender,
            voter.amount,
            voter.unlockTime,
            voter.weight,
            lockedBalance.amount,
            lockedBalance.unlockTime,
            weight
        );

        // update voter amount per account
        voters[msg.sender] = Voter({
            amount: lockedBalance.amount,
            unlockTime: lockedBalance.unlockTime,
            weight: weight
        });
    }

    function _balanceOfAtTimestamp(address account, uint256 timestamp)
        private
        view
        returns (uint256)
    {
        require(timestamp >= block.timestamp, "Must be current or future time");
        Voter memory voter = voters[account];
        if (timestamp > voter.unlockTime) {
            return 0;
        }
        return (voter.amount * (voter.unlockTime - timestamp)) / maxTime;
    }

    function _totalSupplyAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 total = 0;
        for (
            uint256 weekCursor = (timestamp / 1 weeks) * 1 weeks + 1 weeks;
            weekCursor <= timestamp + maxTime;
            weekCursor += 1 weeks
        ) {
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / maxTime;
        }

        return total;
    }

    function _sumAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 sum = 0;
        for (
            uint256 weekCursor = (timestamp / 1 weeks) * 1 weeks + 1 weeks;
            weekCursor <= timestamp + maxTime;
            weekCursor += 1 weeks
        ) {
            sum += (scheduledWeightedUnlock[weekCursor] * (weekCursor - timestamp)) / maxTime;
        }

        return sum;
    }

    function _averageAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 sum = 0;
        uint256 total = 0;
        for (
            uint256 weekCursor = (timestamp / 1 weeks) * 1 weeks + 1 weeks;
            weekCursor <= timestamp + maxTime;
            weekCursor += 1 weeks
        ) {
            sum += (scheduledWeightedUnlock[weekCursor] * (weekCursor - timestamp)) / maxTime;
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / maxTime;
        }

        if (total == 0) {
            return getWeight(maxOption.sub(1) / 2);
        }
        return sum / total;
    }
}
