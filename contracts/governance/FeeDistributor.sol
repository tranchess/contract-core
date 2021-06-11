// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/CoreUtility.sol";

import "../interfaces/IVotingEscrow.sol";

contract FeeDistributor is CoreUtility {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    address public immutable admin;
    uint256 public immutable adminFeeRate;
    uint256 private immutable _maxTime;
    IERC20 public immutable rewardToken;
    IVotingEscrow public immutable votingEscrow;

    /// @notice Timestamp of the last checkpoint
    uint256 public checkpointTimestamp;

    /// @notice Mapping of unlockTime => amount that will be unlocked at unlockTime
    ///
    ///         Key is boundary of unix weeks (Thursday 00:00 UTC), which is different from
    ///         many other mappings in this contract, whose keys are boundary of trading weeks
    ///         (Thursday 14:00 UTC). Amount unlocked before the end of the last checkpoint's
    ///         trading week is not maintained and not used anymore.
    mapping(uint256 => uint256) public scheduledUnlock;

    /// @notice Amount of Chess locked at the end of the last checkpoint's trading week
    uint256 public nextWeekLocked;

    /// @notice Total veCHESS at the end of the last checkpoint's trading week
    uint256 public nextWeekSupply;

    /// @notice Cumulative rewards received until the last checkpoint minus cumulative rewards
    ///         claimed until now
    uint256 public lastRewardBalance;

    /// @notice Mapping of week => total rewards accumulated
    ///
    ///         Key is the start timestamp of a trading week on each Thursday. Value
    ///         is the rewards collected from the corresponding fund in rewardToken's unit
    mapping(uint256 => uint256) public rewardsPerWeek;

    /// @notice Mapping of week => vote-locked chess total supplies
    ///
    ///         Key is the start timestamp of a trading week on each Thursday. Value
    ///         is vote-locked chess total supplies captured at the start of each
    ///         trading week
    mapping(uint256 => uint256) public veSupplyPerWeek;

    /// @notice Locked balance of an account, which is synchronized with `VotingEscrow` when
    ///         `syncWithVotingEscrow()` is called
    mapping(address => IVotingEscrow.LockedBalance) public userLockedBalances;

    /// @notice Start timestamp of the trading week of a user's last checkpoint
    mapping(address => uint256) public userWeekCursors;

    /// @notice An account's veCHESS amount at the beginning of the trading week of this user's
    ///         last checkpoint
    mapping(address => uint256) public userLastBalances;

    /// @notice Mapping of account => amount of claimable Chess
    mapping(address => uint256) public claimableRewards;

    event Synchronized(
        address indexed account,
        uint256 oldAmount,
        uint256 oldUnlockTime,
        uint256 newAmount,
        uint256 newUnlockTime
    );

    constructor(
        address rewardToken_,
        address votingEscrow_,
        address admin_,
        uint256 adminFeeRate_
    ) public {
        rewardToken = IERC20(rewardToken_);
        votingEscrow = IVotingEscrow(votingEscrow_);
        _maxTime = IVotingEscrow(votingEscrow_).maxTime();
        admin = admin_;
        adminFeeRate = adminFeeRate_;
        checkpointTimestamp = block.timestamp;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balanceAtTimestamp(userLockedBalances[account], block.timestamp);
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupplyAtTimestamp(block.timestamp);
    }

    function balanceOfAtTimestamp(address account, uint256 timestamp)
        external
        view
        returns (uint256)
    {
        require(timestamp >= checkpointTimestamp, "Must be current or future time");
        return _balanceAtTimestamp(userLockedBalances[account], timestamp);
    }

    function totalSupplyAtTimestamp(uint256 timestamp) external view returns (uint256) {
        require(timestamp >= checkpointTimestamp, "Must be current or future time");
        return _totalSupplyAtTimestamp(timestamp);
    }

    /// @dev Calculate the amount of veCHESS of a `LockedBalance` at a given timestamp
    function _balanceAtTimestamp(
        IVotingEscrow.LockedBalance memory lockedBalance,
        uint256 timestamp
    ) private view returns (uint256) {
        if (timestamp >= lockedBalance.unlockTime) {
            return 0;
        }
        return lockedBalance.amount.mul(lockedBalance.unlockTime - timestamp) / _maxTime;
    }

    function _totalSupplyAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 total = 0;
        for (
            uint256 weekCursor = (timestamp / 1 weeks) * 1 weeks + 1 weeks;
            weekCursor <= timestamp + _maxTime;
            weekCursor += 1 weeks
        ) {
            total = total.add((scheduledUnlock[weekCursor].mul(weekCursor - timestamp)) / _maxTime);
        }
        return total;
    }

    /// @notice Synchronize an account's locked Chess with `VotingEscrow`.
    /// @param account Address of the synchronized account
    function syncWithVotingEscrow(address account) external {
        userCheckpoint(account);

        uint256 nextWeek = _endOfWeek(block.timestamp);
        IVotingEscrow.LockedBalance memory newLockedBalance =
            votingEscrow.getLockedBalance(account);
        require(
            newLockedBalance.amount > 0 && newLockedBalance.unlockTime > nextWeek,
            "No veCHESS"
        );
        IVotingEscrow.LockedBalance memory oldLockedBalance = userLockedBalances[account];
        uint256 newNextWeekLocked = nextWeekLocked;
        uint256 newNextWeekSupply = nextWeekSupply;

        // Remove the old schedule if there is one
        if (oldLockedBalance.amount > 0 && oldLockedBalance.unlockTime > nextWeek) {
            scheduledUnlock[oldLockedBalance.unlockTime] = scheduledUnlock[
                oldLockedBalance.unlockTime
            ]
                .sub(oldLockedBalance.amount);
            newNextWeekLocked = newNextWeekLocked.sub(oldLockedBalance.amount);
            newNextWeekSupply = newNextWeekSupply.sub(
                oldLockedBalance.amount.mul(oldLockedBalance.unlockTime - nextWeek) / _maxTime
            );
        }

        scheduledUnlock[newLockedBalance.unlockTime] = scheduledUnlock[newLockedBalance.unlockTime]
            .add(newLockedBalance.amount);
        nextWeekLocked = newNextWeekLocked.add(newLockedBalance.amount);
        nextWeekSupply = newNextWeekSupply.add(
            newLockedBalance.amount.mul(newLockedBalance.unlockTime - nextWeek) / _maxTime
        );
        userLockedBalances[account] = newLockedBalance;

        emit Synchronized(
            account,
            oldLockedBalance.amount,
            oldLockedBalance.unlockTime,
            newLockedBalance.amount,
            newLockedBalance.unlockTime
        );
    }

    function userCheckpoint(address account) public returns (uint256 rewards) {
        checkpoint();
        rewards = claimableRewards[account].add(_rewardCheckpoint(account));
        claimableRewards[account] = rewards;
    }

    function claimRewards(address account) external returns (uint256 rewards) {
        checkpoint();
        rewards = claimableRewards[account].add(_rewardCheckpoint(account));
        claimableRewards[account] = 0;
        lastRewardBalance = lastRewardBalance.sub(rewards);
        rewardToken.safeTransfer(account, rewards);
    }

    /// @notice Make a global checkpoint. If the period since the last checkpoint spans over
    ///         multiple trading weeks, rewards received in this period are split into these weeks
    ///         proportional to the time in each week.
    /// @dev Post-conditions:
    ///
    ///      - `checkpointTimestamp == block.timestamp`
    ///      - `lastRewardBalance == rewardToken.balanceOf(address(this))`
    ///      - All `rewardsPerWeek[t]` are updated, where `t <= checkpointTimestamp`
    ///      - All `veSupplyPerWeek[t]` are set, where `t <= checkpointTimestamp`
    ///      - `nextWeekSupply` is the total veCHESS at the end of this unix week
    ///      - `nextWeekLocked` is the total locked Chess at the end of this unix week
    function checkpoint() public {
        uint256 tokenBalance = rewardToken.balanceOf(address(this));
        uint256 tokensToDistribute = tokenBalance.sub(lastRewardBalance);
        lastRewardBalance = tokenBalance;

        uint256 adminFee = tokensToDistribute.multiplyDecimal(adminFeeRate);
        if (adminFee > 0) {
            claimableRewards[admin] = claimableRewards[admin].add(adminFee);
            tokensToDistribute = tokensToDistribute.sub(adminFee);
        }
        uint256 rewardTime = checkpointTimestamp;
        uint256 weekCursor = _endOfWeek(rewardTime) - 1 weeks;
        uint256 currentWeek = _endOfWeek(block.timestamp) - 1 weeks;

        // Update veCHESS supply at the beginning of each week since the last checkpoint.
        if (weekCursor < currentWeek) {
            uint256 newLocked = nextWeekLocked;
            uint256 newSupply = nextWeekSupply;
            // When the total supply drops to zero, the substractions in this loop may underflow
            // due to rounding errors, preventing this contract to proceed. In this case, call
            // `calibrateSupply()` to fix the error.
            for (uint256 w = weekCursor + 1 weeks; w <= currentWeek; w += 1 weeks) {
                veSupplyPerWeek[w] = newSupply;
                // Calculate supply at next Thursday 00:00 UTC.
                newSupply = newSupply.sub(newLocked.mul(1 weeks - SETTLEMENT_TIME) / _maxTime);
                // Remove Chess unlocked at next Thursday 00:00 UTC from total locked amount.
                newLocked = newLocked.sub(scheduledUnlock[w + 1 weeks - SETTLEMENT_TIME]);
                // Calculate supply at the end of the next trading week.
                newSupply = newSupply.sub(newLocked.mul(SETTLEMENT_TIME) / _maxTime);
            }
            nextWeekLocked = newLocked;
            nextWeekSupply = newSupply;
        }

        // Distribute rewards received since the last checkpoint.
        if (tokensToDistribute > 0) {
            if (weekCursor >= currentWeek) {
                rewardsPerWeek[weekCursor] = rewardsPerWeek[weekCursor].add(tokensToDistribute);
            } else {
                uint256 sinceLast = block.timestamp - rewardTime;
                // Calculate the fraction of rewards proportional to the time from
                // the last checkpoint to the end of that week.
                rewardsPerWeek[weekCursor] = rewardsPerWeek[weekCursor].add(
                    tokensToDistribute.mul(weekCursor + 1 weeks - rewardTime) / sinceLast
                );
                weekCursor += 1 weeks;
                // Calculate the fraction of rewards for intermediate whole weeks.
                while (weekCursor < currentWeek) {
                    rewardsPerWeek[weekCursor] = tokensToDistribute.mul(1 weeks) / sinceLast;
                    weekCursor += 1 weeks;
                }
                // Calculate the fraction of rewards proportional to the time from
                // the beginning of the current week to the current block timestamp.
                rewardsPerWeek[weekCursor] =
                    tokensToDistribute.mul(block.timestamp - weekCursor) /
                    sinceLast;
            }
        }

        checkpointTimestamp = block.timestamp;
    }

    /// @dev Calculate rewards since a user's last checkpoint and make a new checkpoint.
    ///
    ///      Post-conditions:
    ///
    ///      - `userWeekCursor[account]` is the start timestamp of the current trading week
    ///      - `userLastBalances[account]` is amount of veCHESS at the beginning of the current trading week
    /// @param account Address of the account
    /// @return Rewards since the last checkpoint
    function _rewardCheckpoint(address account) private returns (uint256) {
        uint256 currentWeek = _endOfWeek(block.timestamp) - 1 weeks;
        uint256 weekCursor = userWeekCursors[account];
        if (weekCursor >= currentWeek) {
            return 0;
        }
        if (weekCursor == 0) {
            userWeekCursors[account] = currentWeek;
            return 0;
        }

        // The week of the last user checkpoint has ended.
        uint256 lastBalance = userLastBalances[account];
        uint256 rewards =
            lastBalance > 0
                ? lastBalance.mul(rewardsPerWeek[weekCursor]) / veSupplyPerWeek[weekCursor]
                : 0;
        weekCursor += 1 weeks;

        // Iterate over succeeding weeks and calculate rewards.
        IVotingEscrow.LockedBalance memory lockedBalance = userLockedBalances[account];
        while (weekCursor < currentWeek) {
            uint256 veChessBalance = _balanceAtTimestamp(lockedBalance, weekCursor);
            if (veChessBalance == 0) {
                break;
            }
            // A positive veChessBalance guarentees that veSupply of that week is also positive
            rewards = rewards.add(
                veChessBalance.mul(rewardsPerWeek[weekCursor]) / veSupplyPerWeek[weekCursor]
            );
            weekCursor += 1 weeks;
        }

        userWeekCursors[account] = currentWeek;
        userLastBalances[account] = _balanceAtTimestamp(lockedBalance, currentWeek);
        return rewards;
    }

    /// @notice Recalculate `nextWeekSupply` from scratch. This function is only required when
    ///         the total supply drops to zero and `checkpoint()` stucks due to rounding errors.
    /// @dev See test cases for the details about the rounding errors.
    function calibrateSupply() external {
        uint256 nextWeek = _endOfWeek(checkpointTimestamp);
        nextWeekSupply = _totalSupplyAtTimestamp(nextWeek);
    }
}
