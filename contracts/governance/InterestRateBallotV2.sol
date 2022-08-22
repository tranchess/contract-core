// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";

import "../interfaces/IBallot.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/IVotingEscrow.sol";

contract InterestRateBallotV2 is IBallot, CoreUtility {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    event Voted(
        address indexed account,
        uint256 oldAmount,
        uint256 oldUnlockTime,
        uint256 oldWeight,
        uint256 amount,
        uint256 indexed unlockTime,
        uint256 indexed weight
    );

    uint256 private immutable _maxTime;

    IVotingEscrow public immutable votingEscrow;

    mapping(address => Voter) public voters;

    // unlockTime => amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;
    mapping(uint256 => uint256) public scheduledWeightedUnlock;

    constructor(address votingEscrow_) public {
        votingEscrow = IVotingEscrow(votingEscrow_);
        _maxTime = IVotingEscrow(votingEscrow_).maxTime();
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

    function averageAtTimestamp(uint256 timestamp) external view returns (uint256) {
        return _averageAtTimestamp(timestamp);
    }

    /// @notice Return a fund's relative income since the last settlement.
    function getFundRelativeIncome(IFundV3 fund) public view returns (uint256) {
        (bool success, bytes memory encodedDay) =
            address(fund).staticcall(abi.encodeWithSignature("currentDay()"));
        if (!success || encodedDay.length != 0x20) {
            return 0;
        }
        uint256 currentDay = abi.decode(encodedDay, (uint256));
        if (currentDay == 0) {
            return 0;
        }
        uint256 version = fund.getRebalanceSize();
        if (version != 0 && fund.getRebalanceTimestamp(version - 1) == block.timestamp) {
            return 0; // Rebalance is triggered
        }
        uint256 lastUnderlying = fund.historicalUnderlying(currentDay - 1 days);
        uint256 lastEquivalentTotalB = fund.historicalEquivalentTotalB(currentDay - 1 days);
        if (lastUnderlying == 0 || lastEquivalentTotalB == 0) {
            return 0;
        }
        uint256 currentUnderlying = fund.getTotalUnderlying();
        uint256 currentEquivalentTotalB = fund.getEquivalentTotalB();
        if (currentUnderlying == 0 || currentEquivalentTotalB == 0) {
            return 0;
        }
        uint256 ratio =
            ((currentUnderlying * lastEquivalentTotalB) / lastUnderlying).divideDecimal(
                currentEquivalentTotalB
            );
        return ratio < 1e18 ? 0 : ratio - 1e18;
    }

    /// @notice Return the fraction of annualized relative income of the calling fund that should
    ///         be added to BISHOP NAV. Zero is returned when this function is not called by
    ///         an `IFundV3` contract or the fund is just rebalanced in the same block.
    function count(uint256 timestamp) external view override returns (uint256) {
        uint256 income = getFundRelativeIncome(IFundV3(msg.sender));
        if (income == 0) {
            return 0;
        } else {
            return income.mul(365).multiplyDecimal(_averageAtTimestamp(timestamp));
        }
    }

    function cast(uint256 weight) external {
        require(weight <= 1e18, "Invalid weight");

        IVotingEscrow.LockedBalance memory lockedBalance =
            votingEscrow.getLockedBalance(msg.sender);
        Voter memory voter = voters[msg.sender];
        require(
            lockedBalance.amount > 0 && lockedBalance.unlockTime > block.timestamp,
            "No veCHESS"
        );

        // update scheduled unlock
        scheduledUnlock[voter.unlockTime] = scheduledUnlock[voter.unlockTime].sub(voter.amount);
        scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime].add(
            lockedBalance.amount
        );

        scheduledWeightedUnlock[voter.unlockTime] = scheduledWeightedUnlock[voter.unlockTime].sub(
            voter.amount * voter.weight
        );
        scheduledWeightedUnlock[lockedBalance.unlockTime] = scheduledWeightedUnlock[
            lockedBalance.unlockTime
        ]
            .add(lockedBalance.amount * weight);

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

    function syncWithVotingEscrow(address account) external override {
        Voter memory voter = voters[account];
        if (voter.amount == 0) {
            return; // The account did not voted before
        }

        IVotingEscrow.LockedBalance memory lockedBalance = votingEscrow.getLockedBalance(account);
        if (lockedBalance.unlockTime <= block.timestamp) {
            return;
        }

        // update scheduled unlock
        scheduledUnlock[voter.unlockTime] = scheduledUnlock[voter.unlockTime].sub(voter.amount);
        scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime].add(
            lockedBalance.amount
        );

        scheduledWeightedUnlock[voter.unlockTime] = scheduledWeightedUnlock[voter.unlockTime].sub(
            voter.amount * voter.weight
        );
        scheduledWeightedUnlock[lockedBalance.unlockTime] = scheduledWeightedUnlock[
            lockedBalance.unlockTime
        ]
            .add(lockedBalance.amount * voter.weight);

        emit Voted(
            account,
            voter.amount,
            voter.unlockTime,
            voter.weight,
            lockedBalance.amount,
            lockedBalance.unlockTime,
            voter.weight
        );

        // update voter amount per account
        voters[account].amount = lockedBalance.amount;
        voters[account].unlockTime = lockedBalance.unlockTime;
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

    function _sumAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 sum = 0;
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            sum += (scheduledWeightedUnlock[weekCursor] * (weekCursor - timestamp)) / _maxTime;
        }

        return sum;
    }

    function _averageAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 sum = 0;
        uint256 total = 0;
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            sum += (scheduledWeightedUnlock[weekCursor] * (weekCursor - timestamp)) / _maxTime;
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / _maxTime;
        }

        if (total == 0) {
            return 0.5e18;
        }
        return sum / total;
    }
}
