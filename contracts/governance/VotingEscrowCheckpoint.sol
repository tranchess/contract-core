// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/CoreUtility.sol";

/// @dev This abstract contract incrementally calculates the total amount of veCHESS in each week.
///      A derived contract should maintain the following state variables:
///
///      * `mapping(uint256 => uint256) scheduledUnlock`, amount of CHESS that will be
///        unlocked in each week in the future.
///      * `mapping(uint256 => uint256) veSupplyPerWeek`, total veCHESS in each week in the past.
///      * `uint256 checkpointWeek`, start timestamp of the week when the checkpoint was updated
///         the last time.
///      * `uint256 nextWeekSupply`, total veCHESS at the end of the last checkpoint's week.
///      * `uint256 totalLocked`, amount of CHESS locked now.
abstract contract VotingEscrowCheckpoint is CoreUtility {
    using SafeMath for uint256;

    uint256 internal immutable _maxTime;

    constructor(uint256 maxTime_) internal {
        _maxTime = maxTime_;
    }

    /// @dev Update checkpoint to the given week and record weekly supply in the past.
    ///      This function should be called before any update to `scheduledUnlock`.
    ///      It writes new values to the `veSupplyPerWeek` mapping. Caller is responsible for
    ///      setting `checkpointWeek`, `nextWeekSupply` and `totalLocked` to the return values.
    /// @param scheduledUnlock amount of CHESS that will be unlocked in each week
    /// @param checkpointWeek the old checkpoint timestamp
    /// @param nextWeekSupply total veCHESS at the end of the last checkpoint's week
    /// @param totalLocked amount of CHESS locked in the last checkpoint
    /// @param veSupplyPerWeek total veCHESS in each week, written by this function
    /// @return newCheckpointWeek the new checkpoint timestamp
    /// @return newNextWeekSupply total veCHESS at the end of this trading week
    /// @return newTotalLocked amount of CHESS locked now
    function _veCheckpoint(
        mapping(uint256 => uint256) storage scheduledUnlock,
        uint256 checkpointWeek,
        uint256 nextWeekSupply,
        uint256 totalLocked,
        mapping(uint256 => uint256) storage veSupplyPerWeek
    )
        internal
        returns (uint256 newCheckpointWeek, uint256 newNextWeekSupply, uint256 newTotalLocked)
    {
        uint256 nextWeek = _endOfWeek(block.timestamp);
        for (uint256 w = checkpointWeek + 1 weeks; w < nextWeek; w += 1 weeks) {
            veSupplyPerWeek[w] = nextWeekSupply;
            // Remove CHESS unlocked at the beginning of the next week from total locked amount.
            totalLocked = totalLocked.sub(scheduledUnlock[w]);
            // Calculate supply at the end of the next week.
            nextWeekSupply = nextWeekSupply.sub(totalLocked.mul(1 weeks) / _maxTime);
        }
        newCheckpointWeek = nextWeek - 1 weeks;
        newNextWeekSupply = nextWeekSupply;
        newTotalLocked = totalLocked;
    }

    /// @dev Update `scheduledUnlock` and the checkpoint according to the change of a user's locked CHESS.
    ///      This function should be called after the checkpoint is updated by `veCheckpoint()`.
    ///      It updates the `scheduledUnlock` mapping. Caller is responsible for setting
    ///      `nextWeekSupply` and `totalLocked` to the return values.
    /// @param nextWeekSupply total veCHESS at the end of this trading week before this change
    /// @param totalLocked amount of CHESS locked before this change
    /// @param oldAmount old amount of locked CHESS
    /// @param oldUnlockTime old unlock timestamp
    /// @param newAmount new amount of locked CHESS
    /// @param newUnlockTime new unlock timestamp
    /// @param scheduledUnlock amount of CHESS that will be unlocked in each week, updated by this function
    /// @return newNextWeekSupply total veCHESS at at the end of this trading week after this change
    /// @return newTotalLocked amount of CHESS locked after this change
    function _veUpdateLock(
        uint256 nextWeekSupply,
        uint256 totalLocked,
        uint256 oldAmount,
        uint256 oldUnlockTime,
        uint256 newAmount,
        uint256 newUnlockTime,
        mapping(uint256 => uint256) storage scheduledUnlock
    ) internal returns (uint256 newNextWeekSupply, uint256 newTotalLocked) {
        uint256 nextWeek = _endOfWeek(block.timestamp);
        newTotalLocked = totalLocked;
        newNextWeekSupply = nextWeekSupply;
        // Remove the old schedule if there is one
        if (oldAmount > 0 && oldUnlockTime >= nextWeek) {
            newTotalLocked = newTotalLocked.sub(oldAmount);
            newNextWeekSupply = newNextWeekSupply.sub(
                oldAmount.mul(oldUnlockTime - nextWeek) / _maxTime
            );
        }
        newTotalLocked = newTotalLocked.add(newAmount);
        // Round up on division when added to the total supply, so that the total supply is never
        // smaller than the sum of all accounts' veCHESS balance.
        newNextWeekSupply = newNextWeekSupply.add(
            newAmount.mul(newUnlockTime - nextWeek).add(_maxTime - 1) / _maxTime
        );

        if (oldUnlockTime == newUnlockTime) {
            scheduledUnlock[oldUnlockTime] = scheduledUnlock[oldUnlockTime].sub(oldAmount).add(
                newAmount
            );
        } else {
            if (oldUnlockTime >= nextWeek) {
                scheduledUnlock[oldUnlockTime] = scheduledUnlock[oldUnlockTime].sub(oldAmount);
            }
            scheduledUnlock[newUnlockTime] = scheduledUnlock[newUnlockTime].add(newAmount);
        }
    }

    /// @dev Calculate the current total veCHESS amount from the last checkpoint.
    /// @param scheduledUnlock amount of CHESS that will be unlocked in each week
    /// @param checkpointWeek the last checkpoint timestamp
    /// @param nextWeekSupply total veCHESS at the end of the last checkpoint's week
    /// @param totalLocked amount of CHESS locked in the last checkpoint
    /// @return Current total veCHESS amount
    function _veTotalSupply(
        mapping(uint256 => uint256) storage scheduledUnlock,
        uint256 checkpointWeek,
        uint256 nextWeekSupply,
        uint256 totalLocked
    ) internal view returns (uint256) {
        uint256 nextWeek = _endOfWeek(block.timestamp);
        uint256 thisWeek = nextWeek - 1 weeks;
        if (checkpointWeek + 1 weeks < nextWeek) {
            for (uint256 w = checkpointWeek + 1 weeks; w < thisWeek; w += 1 weeks) {
                // Remove CHESS unlocked at the beginning of the next week from total locked amount.
                totalLocked = totalLocked.sub(scheduledUnlock[w]);
                // Calculate supply at the end of the next week.
                nextWeekSupply = nextWeekSupply.sub(totalLocked.mul(1 weeks) / _maxTime);
            }
            totalLocked = totalLocked.sub(scheduledUnlock[thisWeek]);
            return nextWeekSupply.sub(totalLocked.mul(block.timestamp - thisWeek) / _maxTime);
        } else {
            return nextWeekSupply.add(totalLocked.mul(nextWeek - block.timestamp) / _maxTime);
        }
    }

    /// @dev Calculate the total veCHESS amount at a given trading week boundary. The given week
    ///      start timestamp must be later than the last checkpoint. For older weeks,
    ///      derived contract should read from the `veSupplyPerWeek` mapping instead.
    /// @param week Start timestamp of a trading week, must be greater than `checkpointWeek`
    /// @param scheduledUnlock amount of CHESS that will be unlocked in each week
    /// @param checkpointWeek the last checkpoint timestamp
    /// @param nextWeekSupply total veCHESS at the end of the last checkpoint's week
    /// @param totalLocked amount of CHESS locked in the last checkpoint
    /// @return Total veCHESS amount at `week`
    function _veTotalSupplyAtWeek(
        uint256 week,
        mapping(uint256 => uint256) storage scheduledUnlock,
        uint256 checkpointWeek,
        uint256 nextWeekSupply,
        uint256 totalLocked
    ) internal view returns (uint256) {
        if (checkpointWeek + 1 weeks < week) {
            for (uint256 w = checkpointWeek + 1 weeks; w < week; w += 1 weeks) {
                // Remove CHESS unlocked at the beginning of the next week from total locked amount.
                totalLocked = totalLocked.sub(scheduledUnlock[w]);
                // Calculate supply at the end of the next week.
                nextWeekSupply = nextWeekSupply.sub(totalLocked.mul(1 weeks) / _maxTime);
            }
        }
        return nextWeekSupply;
    }
}
