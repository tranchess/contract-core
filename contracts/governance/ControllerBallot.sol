// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";

import "../interfaces/IControllerBallot.sol";
import "../interfaces/IVotingEscrow.sol";

contract ControllerBallot is IControllerBallot, Ownable, CoreUtility {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    event PoolAdded(address pool);
    event Voted(
        address indexed account,
        uint256[] oldWeights,
        uint256 oldUnlockTime,
        uint256[] weights,
        uint256 indexed unlockTime
    );

    uint256 private immutable _maxTime;

    IVotingEscrow public immutable votingEscrow;

    address[65535] private _pools;
    uint256 public poolSize;
    mapping(address => IVotingEscrow.LockedBalance) public voterLockedBalances;
    mapping(address => mapping(address => uint256)) public voterWeights;

    // unlockTime => amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;
    mapping(address => mapping(uint256 => uint256)) public scheduledWeightedUnlock;

    constructor(address votingEscrow_) public {
        votingEscrow = IVotingEscrow(votingEscrow_);
        _maxTime = IVotingEscrow(votingEscrow_).maxTime();
    }

    function getPools() external view returns (address[] memory) {
        uint256 size = poolSize;
        address[] memory ret = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            ret[i] = _pools[i];
        }
        return ret;
    }

    function addPool(address newPool) external onlyOwner {
        uint256 size = poolSize;
        _pools[size] = newPool;
        poolSize = size + 1;
        emit PoolAdded(newPool);
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
        returns (uint256[] memory weights, address[] memory pools)
    {
        (uint256[] memory sums, uint256 total) = _countAtTimestamp(timestamp);

        uint256 size = poolSize;
        weights = new uint256[](size);
        pools = new address[](size);
        if (total == 0) {
            for (uint256 i = 0; i < size; i++) {
                weights[i] = 1e18 / size;
                pools[i] = _pools[i];
            }
        } else {
            for (uint256 i = 0; i < size; i++) {
                weights[i] = sums[i].divideDecimal(total);
                pools[i] = _pools[i];
            }
        }
    }

    function cast(uint256[] memory weights) external {
        uint256 size = poolSize;
        require(weights.length == size, "Invalid number of weights");
        uint256 totalWeight;
        for (uint256 i = 0; i < size; i++) {
            totalWeight = totalWeight.add(weights[i]);
        }
        require(totalWeight <= 1e18, "Weights too large");

        uint256[] memory oldWeights = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            oldWeights[i] = voterWeights[msg.sender][_pools[i]];
        }

        IVotingEscrow.LockedBalance memory oldLockedBalance = voterLockedBalances[msg.sender];
        IVotingEscrow.LockedBalance memory lockedBalance =
            votingEscrow.getLockedBalance(msg.sender);
        require(
            lockedBalance.amount > 0 && lockedBalance.unlockTime > block.timestamp,
            "Zero value"
        );

        _updateVoteStatus(msg.sender, size, oldWeights, weights, oldLockedBalance, lockedBalance);
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

        uint256 size = poolSize;
        uint256[] memory oldWeights = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            oldWeights[i] = voterWeights[account][_pools[i]];
        }

        _updateVoteStatus(account, size, oldWeights, oldWeights, oldLockedBalance, lockedBalance);
    }

    /// @dev The sum of weighs should be equal to 1e18
    function _updateVoteStatus(
        address account,
        uint256 size,
        uint256[] memory oldWeights,
        uint256[] memory weights,
        IVotingEscrow.LockedBalance memory oldLockedBalance,
        IVotingEscrow.LockedBalance memory lockedBalance
    ) private {
        uint256[] memory oldAllocations = new uint256[](size);
        uint256[] memory newAllocations = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            address pool = _pools[i];
            uint256 oldAllocation = oldLockedBalance.amount.multiplyDecimal(oldWeights[i]);
            scheduledUnlock[oldLockedBalance.unlockTime] = scheduledUnlock[
                oldLockedBalance.unlockTime
            ]
                .sub(oldAllocation);
            scheduledWeightedUnlock[pool][oldLockedBalance.unlockTime] = scheduledWeightedUnlock[
                pool
            ][oldLockedBalance.unlockTime]
                .sub(oldAllocation);

            uint256 newAllocation = lockedBalance.amount.multiplyDecimal(weights[i]);
            scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime]
                .add(newAllocation);
            scheduledWeightedUnlock[pool][lockedBalance.unlockTime] = scheduledWeightedUnlock[pool][
                lockedBalance.unlockTime
            ]
                .add(newAllocation);

            oldAllocations[i] = oldAllocation;
            newAllocations[i] = newAllocation;
            voterWeights[account][pool] = weights[i];
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
            sum +=
                (scheduledWeightedUnlock[fund][weekCursor] * (weekCursor - timestamp)) /
                _maxTime;
        }

        return sum;
    }

    function _countAtTimestamp(uint256 timestamp)
        private
        view
        returns (uint256[] memory sums, uint256 total)
    {
        uint256 size = poolSize;
        sums = new uint256[](size);
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            for (uint256 i = 0; i < size; i++) {
                sums[i] +=
                    (scheduledWeightedUnlock[_pools[i]][weekCursor] * (weekCursor - timestamp)) /
                    _maxTime;
            }
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / _maxTime;
        }
    }
}
