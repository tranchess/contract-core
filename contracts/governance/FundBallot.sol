// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";

import "../interfaces/IFundBallot.sol";
import "../interfaces/IVotingEscrow.sol";

contract FundBallot is IFundBallot, Ownable, CoreUtility {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    event FundAdded(address newFund);
    event Voted(
        address indexed account,
        uint256[] oldAmounts,
        uint256 oldUnlockTime,
        uint256[] fundWeights,
        uint256 indexed unlockTime
    );

    uint256 private immutable _maxTime;

    IVotingEscrow public immutable votingEscrow;

    address[65535] private _fundSet;
    uint256 public fundSetLength;
    mapping(address => IVotingEscrow.LockedBalance) public voterLockedBalances;
    mapping(address => mapping(address => uint256)) public fundWeights;

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
        _fundSet[fundSetLength] = newFund;
        fundSetLength += 1;
        emit FundAdded(newFund);
    }

    function getReceipt(address account)
        external
        view
        returns (IVotingEscrow.LockedBalance memory)
    {
        return voterLockedBalances[account];
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

        uint256 fundLength = fundSetLength;
        ratios = new uint256[](fundLength);
        funds = new address[](fundLength);
        if (total == 0) {
            for (uint256 fundCursor = 0; fundCursor < fundLength; fundCursor++) {
                ratios[fundCursor] = 1e18 / fundLength;
                funds[fundCursor] = _fundSet[fundCursor];
            }
        } else {
            for (uint256 fundCursor = 0; fundCursor < fundLength; fundCursor++) {
                ratios[fundCursor] = (sums[fundCursor] * 1e18) / total;
                funds[fundCursor] = _fundSet[fundCursor];
            }
        }
    }

    function cast(uint256[] memory weights) external {
        uint256 fundLength = fundSetLength;
        require(weights.length == fundLength, "Invalid number of weights");

        uint256 totalWeight;
        for (uint256 i = 0; i < weights.length; i++) {
            totalWeight = totalWeight.add(weights[i]);
        }
        require(totalWeight == 1e18, "Invalid weights");

        uint256[] memory oldWeights = new uint256[](fundLength);
        for (uint256 i = 0; i < fundSetLength; i++) {
            oldWeights[i] = fundWeights[msg.sender][_fundSet[i]];
        }

        IVotingEscrow.LockedBalance memory lockedBalance =
            votingEscrow.getLockedBalance(msg.sender);
        IVotingEscrow.LockedBalance memory oldLockedBalance = voterLockedBalances[msg.sender];
        require(lockedBalance.amount > 0, "Zero value");

        // update scheduled unlock
        _updateVoteStatus(
            msg.sender,
            fundLength,
            oldWeights,
            weights,
            oldLockedBalance,
            lockedBalance
        );
    }

    function syncWithVotingEscrow(address account) external override {
        IVotingEscrow.LockedBalance memory oldLockedBalance = voterLockedBalances[account];
        if (oldLockedBalance.amount == 0) {
            return; // The account did not voted before
        }

        IVotingEscrow.LockedBalance memory lockedBalance = votingEscrow.getLockedBalance(account);
        if (lockedBalance.amount == 0 || lockedBalance.unlockTime <= block.timestamp) {
            return;
        }

        uint256 fundLength = fundSetLength;
        uint256[] memory oldWeights = new uint256[](fundLength);
        for (uint256 i = 0; i < fundSetLength; i++) {
            oldWeights[i] = fundWeights[account][_fundSet[i]];
        }

        _updateVoteStatus(
            account,
            fundLength,
            oldWeights,
            oldWeights,
            oldLockedBalance,
            lockedBalance
        );
    }

    /// @dev The sum of weighs should be equal to 1e18
    function _updateVoteStatus(
        address account,
        uint256 fundLength,
        uint256[] memory oldWeights,
        uint256[] memory weights,
        IVotingEscrow.LockedBalance memory oldLockedBalance,
        IVotingEscrow.LockedBalance memory lockedBalance
    ) private {
        uint256[] memory oldAllocations = new uint256[](fundLength);
        uint256[] memory newAllocations = new uint256[](fundLength);
        for (uint256 iFund = 0; iFund < fundLength; iFund++) {
            address fund = _fundSet[iFund];
            uint256 oldAllocation = oldLockedBalance.amount.multiplyDecimal(oldWeights[iFund]);
            scheduledUnlock[oldLockedBalance.unlockTime] = scheduledUnlock[
                oldLockedBalance.unlockTime
            ]
                .sub(oldAllocation);
            scheduledFundUnlock[fund][oldLockedBalance.unlockTime] = scheduledFundUnlock[fund][
                oldLockedBalance.unlockTime
            ]
                .sub(oldAllocation);

            uint256 newAllocation = lockedBalance.amount.multiplyDecimal(weights[iFund]);
            scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime]
                .add(newAllocation);
            scheduledFundUnlock[fund][lockedBalance.unlockTime] = scheduledFundUnlock[fund][
                lockedBalance.unlockTime
            ]
                .add(newAllocation);

            oldAllocations[iFund] = oldAllocation;
            newAllocations[iFund] = newAllocation;
            fundWeights[account][fund] = weights[iFund];
        }

        emit Voted(
            account,
            oldAllocations,
            oldLockedBalance.unlockTime,
            newAllocations,
            lockedBalance.unlockTime
        );

        voterLockedBalances[account] = lockedBalance;
    }

    function _balanceOfAtTimestamp(address account, uint256 timestamp)
        private
        view
        returns (uint256)
    {
        require(timestamp >= block.timestamp, "Must be current or future time");
        IVotingEscrow.LockedBalance memory oldLockedBalance = voterLockedBalances[account];
        if (timestamp > oldLockedBalance.unlockTime) {
            return 0;
        }
        return (oldLockedBalance.amount * (oldLockedBalance.unlockTime - timestamp)) / _maxTime;
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
        uint256 fundLength = fundSetLength;
        sums = new uint256[](fundLength);
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            for (uint256 fundCursor = 0; fundCursor < fundLength; fundCursor++) {
                sums[fundCursor] +=
                    (scheduledFundUnlock[_fundSet[fundCursor]][weekCursor] *
                        (weekCursor - timestamp)) /
                    _maxTime;
            }
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / _maxTime;
        }
    }
}
