// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../interfaces/IVotingEscrow.sol";

interface ISmartWalletChecker {
    function check(address account) external view returns (bool);
}

contract VotingEscrow is IVotingEscrow, ReentrancyGuard {
    using SafeMath for uint256;

    uint256 public immutable override maxTime;

    string public name;
    string public symbol;

    address public override token;
    address public checker;

    mapping(address => LockedBalance) public locked;

    // unlockTime => amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;

    constructor(
        address _token,
        address _checker,
        string memory _name,
        string memory _symbol,
        uint256 _maxTime
    ) public {
        name = _name;
        symbol = _symbol;
        token = _token;
        checker = _checker;
        maxTime = _maxTime;
    }

    function getTimestampDropBelow(address account, uint256 threshold)
        external
        view
        override
        returns (uint256)
    {
        LockedBalance memory lockedBalance = locked[account];
        if (lockedBalance.amount == 0 || lockedBalance.amount < threshold) {
            return 0;
        }
        return lockedBalance.unlockTime.sub(threshold.mul(maxTime).div(lockedBalance.amount));
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balanceOfAtTimestamp(account, block.timestamp);
    }

    function totalSupply() external view override returns (uint256) {
        return _totalSupplyAtTimestamp(block.timestamp);
    }

    function getLockedBalance(address account)
        external
        view
        override
        returns (LockedBalance memory)
    {
        return locked[account];
    }

    function balanceOfAtTimestamp(address account, uint256 timestamp)
        external
        view
        override
        returns (uint256)
    {
        return _balanceOfAtTimestamp(account, timestamp);
    }

    function totalSupplyAtTimestamp(uint256 timestamp) external view returns (uint256) {
        return _totalSupplyAtTimestamp(timestamp);
    }

    // -------------------------------------------------------------------------
    function depositFor(address account, uint256 amount) public nonReentrant {
        LockedBalance memory lockedBalance = locked[account];

        require(amount > 0, "zero value");
        require(lockedBalance.unlockTime > block.timestamp, "Cannot add to expired lock. Withdraw");

        _lock(account, amount, 0, lockedBalance, LockType.DEPOSIT_FOR_TYPE);
    }

    function createLock(uint256 amount, uint256 unlockTime) public nonReentrant {
        _assertNotContract(msg.sender);

        unlockTime = (unlockTime / 1 weeks) * 1 weeks; // Locktime is rounded down to weeks
        LockedBalance memory lockedBalance = locked[msg.sender];

        require(amount > 0, "zero value");
        require(lockedBalance.amount == 0, "Withdraw old tokens first");
        require(unlockTime > block.timestamp, "Can only lock until time in the future");
        require(unlockTime <= block.timestamp + maxTime, "Voting lock cannot exceed max lock time");

        _lock(msg.sender, amount, unlockTime, lockedBalance, LockType.CREATE_LOCK_TYPE);
    }

    function increaseAmount(uint256 amount) public nonReentrant {
        _assertNotContract(msg.sender);
        LockedBalance memory lockedBalance = locked[msg.sender];

        require(amount > 0, "zero value");
        require(lockedBalance.unlockTime > block.timestamp, "Cannot add to expired lock. Withdraw");

        _lock(msg.sender, amount, 0, lockedBalance, LockType.INCREASE_LOCK_AMOUNT);
    }

    function increaseUnlockTime(uint256 unlockTime) public nonReentrant {
        _assertNotContract(msg.sender);
        LockedBalance memory lockedBalance = locked[msg.sender];
        unlockTime = (unlockTime / 1 weeks) * 1 weeks; // Locktime is rounded down to weeks

        require(lockedBalance.unlockTime > block.timestamp, "Lock expired");
        require(unlockTime > lockedBalance.unlockTime, "Can only increase lock duration");
        require(unlockTime <= block.timestamp + maxTime, "Voting lock cannot exceed max lock time");

        _lock(msg.sender, 0, unlockTime, lockedBalance, LockType.INCREASE_UNLOCK_TIME);
    }

    function withdraw() public nonReentrant {
        LockedBalance memory lockedBalance = locked[msg.sender];
        require(block.timestamp >= lockedBalance.unlockTime, "The lock didn't expire");
        uint256 amount = uint256(lockedBalance.amount);

        lockedBalance.unlockTime = 0;
        lockedBalance.amount = 0;
        locked[msg.sender] = lockedBalance;

        IERC20(token).transfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    function _assertNotContract(address account) private view {
        if (Address.isContract(account) && checker != address(0)) {
            if (ISmartWalletChecker(checker).check(account)) {
                return;
            }
            revert("Smart contract depositors not allowed");
        }
    }

    function _balanceOfAtTimestamp(address account, uint256 timestamp)
        private
        view
        returns (uint256)
    {
        require(timestamp >= block.timestamp, "must be current or future time");
        LockedBalance memory lockedBalance = locked[account];
        if (timestamp > lockedBalance.unlockTime) {
            return 0;
        }
        return (lockedBalance.amount.mul(lockedBalance.unlockTime - timestamp)) / maxTime;
    }

    function _totalSupplyAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 weekCursor = (timestamp / 1 weeks) * 1 weeks + 1 weeks;
        uint256 total = 0;
        for (; weekCursor <= timestamp + maxTime; weekCursor += 1 weeks) {
            total = total.add((scheduledUnlock[weekCursor].mul(weekCursor - timestamp)) / maxTime);
        }

        return total;
    }

    function _lock(
        address account,
        uint256 amount,
        uint256 unlockTime,
        LockedBalance memory lockedBalance,
        LockType lockType
    ) private {
        if (unlockTime != 0) {
            // update scheduled unlock
            scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime]
                .sub(lockedBalance.amount);
            scheduledUnlock[unlockTime] = scheduledUnlock[unlockTime].add(lockedBalance.amount).add(
                amount
            );

            // update unlock time per account
            locked[account].unlockTime = unlockTime;
        } else {
            scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime]
                .add(amount);
        }

        if (amount != 0) {
            IERC20(token).transferFrom(account, address(this), amount);
            // update locked amount per account
            locked[account].amount = lockedBalance.amount.add(amount);
        }

        emit Locked(account, amount, unlockTime, lockType);
    }
}
