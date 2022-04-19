// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";

import {IVotingEscrowCallback} from "../governance/VotingEscrowV2.sol";
import "../interfaces/IControllerBallot.sol";
import "../interfaces/IVotingEscrow.sol";

contract ControllerBallot is IControllerBallot, IVotingEscrowCallback, Ownable, CoreUtility {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    event PoolAdded(address pool);
    event PoolToggled(address indexed pool, bool isDisabled);
    event Voted(
        address indexed account,
        uint256 oldAmount,
        uint256 oldUnlockTime,
        uint256[] oldWeights,
        uint256 amount,
        uint256 unlockTime,
        uint256[] weights
    );

    IVotingEscrow public immutable votingEscrow;
    uint256 private immutable _maxTime;

    address[65535] private _pools;
    uint256 public poolSize;
    uint256 public disabledPoolSize;

    /// @notice Locked balance of an account, which is synchronized with `VotingEscrow` when
    ///         `syncWithVotingEscrow()` is called
    mapping(address => IVotingEscrow.LockedBalance) public userLockedBalances;

    /// @notice Mapping of account => pool => fraction of the user's veCHESS voted to the pool
    mapping(address => mapping(address => uint256)) public userWeights;

    /// @notice Mapping of pool => unlockTime => CHESS amount voted to the pool that will be
    ///         unlocked at unlockTime
    mapping(address => mapping(uint256 => uint256)) public poolScheduledUnlock;

    /// @notice Mapping of pool => status of the pool
    mapping(uint256 => bool) public disabledPools;

    constructor(address votingEscrow_) public {
        votingEscrow = IVotingEscrow(votingEscrow_);
        _maxTime = IVotingEscrow(votingEscrow_).maxTime();
    }

    function getPools() external view returns (address[] memory) {
        uint256 size = poolSize;
        address[] memory pools = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            pools[i] = _pools[i];
        }
        return pools;
    }

    function addPool(address newPool) external onlyOwner {
        uint256 size = poolSize;
        _pools[size] = newPool;
        poolSize = size + 1;
        emit PoolAdded(newPool);
    }

    function togglePool(uint256 index) external onlyOwner {
        require(index < poolSize, "Invalid index");
        if (disabledPools[index]) {
            disabledPools[index] = false;
            disabledPoolSize--;
        } else {
            disabledPools[index] = true;
            disabledPoolSize++;
        }
        emit PoolToggled(_pools[index], disabledPools[index]);
    }

    function balanceOf(address account) external view returns (uint256) {
        return balanceOfAtTimestamp(account, block.timestamp);
    }

    function balanceOfAtTimestamp(address account, uint256 timestamp)
        public
        view
        returns (uint256)
    {
        require(timestamp >= block.timestamp, "Must be current or future time");
        IVotingEscrow.LockedBalance memory locked = userLockedBalances[account];
        if (timestamp >= locked.unlockTime) {
            return 0;
        }
        return locked.amount.mul(locked.unlockTime - timestamp) / _maxTime;
    }

    function totalSupply() external view returns (uint256) {
        return totalSupplyAtTimestamp(block.timestamp);
    }

    function totalSupplyAtTimestamp(uint256 timestamp) public view returns (uint256) {
        uint256 size = poolSize;
        uint256 total = 0;
        for (uint256 i = 0; i < size; i++) {
            total = total.add(sumAtTimestamp(_pools[i], timestamp));
        }
        return total;
    }

    function sumAtTimestamp(address pool, uint256 timestamp) public view returns (uint256) {
        uint256 sum = 0;
        for (
            uint256 weekCursor = _endOfWeek(timestamp);
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            sum = sum.add(
                poolScheduledUnlock[pool][weekCursor].mul(weekCursor - timestamp) / _maxTime
            );
        }
        return sum;
    }

    function count(uint256 timestamp)
        external
        view
        override
        returns (uint256[] memory weights, address[] memory pools)
    {
        uint256 poolSize_ = poolSize;
        uint256 size = poolSize_ - disabledPoolSize;
        pools = new address[](size);
        uint256 j = 0;
        for (uint256 i = 0; i < poolSize_ && j < size; i++) {
            address pool = _pools[i];
            if (!disabledPools[i]) pools[j++] = pool;
        }

        uint256[] memory sums = new uint256[](size);
        uint256 total = 0;
        for (uint256 i = 0; i < size; i++) {
            uint256 sum = sumAtTimestamp(pools[i], timestamp);
            sums[i] = sum;
            total = total.add(sum);
        }

        weights = new uint256[](size);
        if (total == 0) {
            for (uint256 i = 0; i < size; i++) {
                weights[i] = 1e18 / size;
            }
        } else {
            for (uint256 i = 0; i < size; i++) {
                weights[i] = sums[i].divideDecimal(total);
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
        require(totalWeight == 1e18, "Invalid weights");

        uint256[] memory oldWeights = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            oldWeights[i] = userWeights[msg.sender][_pools[i]];
        }

        IVotingEscrow.LockedBalance memory oldLockedBalance = userLockedBalances[msg.sender];
        IVotingEscrow.LockedBalance memory lockedBalance =
            votingEscrow.getLockedBalance(msg.sender);
        require(
            lockedBalance.amount > 0 && lockedBalance.unlockTime > block.timestamp,
            "No veCHESS"
        );

        _updateVoteStatus(msg.sender, size, oldWeights, weights, oldLockedBalance, lockedBalance);
    }

    function syncWithVotingEscrow(address account) external override {
        IVotingEscrow.LockedBalance memory oldLockedBalance = userLockedBalances[account];
        if (oldLockedBalance.amount == 0) {
            return; // The account did not voted before
        }
        IVotingEscrow.LockedBalance memory lockedBalance = votingEscrow.getLockedBalance(account);
        if (lockedBalance.amount == 0 || lockedBalance.unlockTime <= block.timestamp) {
            return;
        }

        uint256 size = poolSize;
        uint256[] memory weights = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            weights[i] = userWeights[account][_pools[i]];
        }

        _updateVoteStatus(account, size, weights, weights, oldLockedBalance, lockedBalance);
    }

    function _updateVoteStatus(
        address account,
        uint256 size,
        uint256[] memory oldWeights,
        uint256[] memory weights,
        IVotingEscrow.LockedBalance memory oldLockedBalance,
        IVotingEscrow.LockedBalance memory lockedBalance
    ) private {
        for (uint256 i = 0; i < size; i++) {
            address pool = _pools[i];
            poolScheduledUnlock[pool][oldLockedBalance.unlockTime] = poolScheduledUnlock[pool][
                oldLockedBalance.unlockTime
            ]
                .sub(oldLockedBalance.amount.multiplyDecimal(oldWeights[i]));

            poolScheduledUnlock[pool][lockedBalance.unlockTime] = poolScheduledUnlock[pool][
                lockedBalance.unlockTime
            ]
                .add(lockedBalance.amount.multiplyDecimal(weights[i]));
            userWeights[account][pool] = weights[i];
        }
        userLockedBalances[account] = lockedBalance;
        emit Voted(
            account,
            oldLockedBalance.amount,
            oldLockedBalance.unlockTime,
            oldWeights,
            lockedBalance.amount,
            lockedBalance.unlockTime,
            weights
        );
    }
}
