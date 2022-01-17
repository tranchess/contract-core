// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/CoreUtility.sol";

import "../interfaces/IFundBallot.sol";
import "../interfaces/IVotingEscrow.sol";

struct Voter {
    uint256[] allocations;
    uint256 amount;
    uint256 unlockTime;
}

contract FundBallot is IFundBallot, Ownable, CoreUtility {
    using SafeMath for uint256;

    event FundAdded(address newFund);
    event Voted(
        address indexed account,
        uint256[] oldAmounts,
        uint256 oldUnlockTime,
        uint256[] allocations,
        uint256 indexed unlockTime
    );

    uint256 private immutable _maxTime;

    IVotingEscrow public immutable votingEscrow;

    address[] private fundSet;
    mapping(address => Voter) public voters;

    // unlockTime => amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;
    mapping(address => mapping(uint256 => uint256)) public scheduledFundUnlock;

    constructor(address votingEscrow_, address[] memory funds_) public {
        require(funds_.length != 0);
        votingEscrow = IVotingEscrow(votingEscrow_);
        _maxTime = IVotingEscrow(votingEscrow_).maxTime();
        for (uint256 i = 0; i < funds_.length; i++) {
            addFund(funds_[i]);
        }
    }

    function addFund(address newFund) public onlyOwner {
        fundSet.push(newFund);
        emit FundAdded(newFund);
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

    function sumAtTimestamp(address fund, uint256 timestamp) external view returns (uint256) {
        return _sumAtTimestamp(fund, timestamp);
    }

    function count(uint256 timestamp)
        external
        view
        override
        returns (uint256[] memory ratios, address[] memory funds)
    {
        (uint256[] memory sums, uint256 total) = _countAtTimestamp(timestamp);

        uint256 fundLength = fundSet.length;
        ratios = new uint256[](fundLength);
        funds = fundSet;
        if (total == 0) {
            for (uint256 fundCursor = 0; fundCursor < fundLength; fundCursor++) {
                ratios[fundCursor] = 1e18 / fundLength;
            }
        } else {
            for (uint256 fundCursor = 0; fundCursor < fundLength; fundCursor++) {
                ratios[fundCursor] = (sums[fundCursor] * 1e18) / total;
            }
        }
    }

    function cast(uint256[] memory weights) external {
        require(weights.length == fundSet.length, "Invalid number of weights");
        uint256 totalOption = weights[0].add(weights[1]).add(weights[2]);
        require(totalOption == 1e18, "Invalid weights");

        IVotingEscrow.LockedBalance memory lockedBalance =
            votingEscrow.getLockedBalance(msg.sender);
        Voter memory voter = voters[msg.sender];
        require(lockedBalance.amount > 0, "Zero value");

        // update scheduled unlock
        uint256 fundLength = fundSet.length;
        uint256 allocationLength = voter.allocations.length;
        uint256[] memory optionAllocations = new uint256[](fundLength);
        for (uint256 iFund = 0; iFund < fundLength; iFund++) {
            address fund = fundSet[iFund];
            if (iFund < allocationLength) {
                scheduledUnlock[voter.unlockTime] = scheduledUnlock[voter.unlockTime].sub(
                    voter.allocations[iFund]
                );
                scheduledFundUnlock[fund][voter.unlockTime] = scheduledFundUnlock[fund][
                    voter.unlockTime
                ]
                    .sub(voter.allocations[iFund]);
            }

            uint256 optionAllocation = lockedBalance.amount.mul(weights[iFund]).div(totalOption);
            scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime]
                .add(optionAllocation);
            scheduledFundUnlock[fund][lockedBalance.unlockTime] = scheduledFundUnlock[fund][
                lockedBalance.unlockTime
            ]
                .add(optionAllocation);

            optionAllocations[iFund] = optionAllocation;
        }

        emit Voted(
            msg.sender,
            voter.allocations,
            voter.unlockTime,
            optionAllocations,
            lockedBalance.unlockTime
        );

        // update voter allocations per account
        voters[msg.sender].allocations = optionAllocations;
        voters[msg.sender].amount = lockedBalance.amount;
        voters[msg.sender].unlockTime = lockedBalance.unlockTime;
    }

    function syncWithVotingEscrow(address account) external override {
        Voter memory voter = voters[account];
        if (voter.amount == 0) {
            return; // The account did not voted before
        }

        IVotingEscrow.LockedBalance memory lockedBalance = votingEscrow.getLockedBalance(account);
        if (lockedBalance.amount == 0 || lockedBalance.unlockTime <= block.timestamp) {
            return;
        }

        // update scheduled unlock only for existing allocations
        uint256 fundLength = fundSet.length;
        uint256 allocationLength = voter.allocations.length;
        uint256[] memory optionAllocations = new uint256[](fundLength);
        for (uint256 iFund = 0; iFund < allocationLength; iFund++) {
            uint256 optionAllocation =
                lockedBalance.amount.mul(voter.allocations[iFund]).div(voter.amount);
            scheduledUnlock[voter.unlockTime] = scheduledUnlock[voter.unlockTime].sub(
                voter.allocations[iFund]
            );
            scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime]
                .add(optionAllocation);

            address fund = fundSet[iFund];
            scheduledFundUnlock[fund][voter.unlockTime] = scheduledFundUnlock[fund][
                voter.unlockTime
            ]
                .sub(voter.allocations[iFund]);
            scheduledFundUnlock[fund][lockedBalance.unlockTime] = scheduledFundUnlock[fund][
                lockedBalance.unlockTime
            ]
                .add(optionAllocation);

            optionAllocations[iFund] = optionAllocation;
        }

        emit Voted(
            msg.sender,
            voter.allocations,
            voter.unlockTime,
            optionAllocations,
            lockedBalance.unlockTime
        );

        // update voter allocations per account
        voters[msg.sender].allocations = optionAllocations;
        voters[msg.sender].amount = lockedBalance.amount;
        voters[msg.sender].unlockTime = lockedBalance.unlockTime;
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
        return (voter.amount * (voter.unlockTime - timestamp)) / _maxTime;
    }

    function _totalSupplyAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 total = 0;
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / _maxTime;
        }

        return total;
    }

    function _sumAtTimestamp(address fund, uint256 timestamp) private view returns (uint256) {
        uint256 sum = 0;
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            sum += (scheduledFundUnlock[fund][weekCursor] * (weekCursor - timestamp)) / _maxTime;
        }

        return sum;
    }

    function _countAtTimestamp(uint256 timestamp)
        private
        view
        returns (uint256[] memory sums, uint256 total)
    {
        uint256 fundLength = fundSet.length;
        sums = new uint256[](fundLength);
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            for (uint256 fundCursor = 0; fundCursor < fundLength; fundCursor++) {
                sums[fundCursor] +=
                    (scheduledFundUnlock[fundSet[fundCursor]][weekCursor] *
                        (weekCursor - timestamp)) /
                    _maxTime;
            }
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / _maxTime;
        }
    }
}
