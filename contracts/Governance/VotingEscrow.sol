// SPDX-License-Identifier: MIT
pragma experimental ABIEncoderV2;
pragma solidity 0.6.9;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../interfaces/IVotingEscrow.sol";

interface ISmartWalletChecker {
    function check(address account) external view returns (bool);
}

contract VotingEscrow is IVotingEscrow, ReentrancyGuard {
    uint256 public MAX_TIME = 4 * 365 days;

    string name;
    string symbol;

    address public override token;
    address public checker;

    mapping(address => LockedBalance) public locked;

    // unlockTime => amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;

    constructor(
        address _token,
        address _checker,
        string memory _name,
        string memory _symbol
    ) public {
        name = _name;
        symbol = _symbol;
        token = _token;
        checker = _checker;
    }

    function getTimestampDropBelow(address account, uint256 threshold)
        external
        view
        override
        returns (uint256)
    {
        LockedBalance memory lockedBalance = locked[account];
        if (lockedBalance.amount <= threshold) {
            return 0;
        }
        return lockedBalance.unlockTime - ((MAX_TIME * threshold) / lockedBalance.amount);
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
        require(lockedBalance.amount > 0, "No existing lock found");
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
        require(unlockTime <= block.timestamp + MAX_TIME, "Voting lock can be 4 years max");

        _lock(msg.sender, amount, unlockTime, lockedBalance, LockType.CREATE_LOCK_TYPE);
    }

    function increaseAmount(uint256 amount) public nonReentrant {
        _assertNotContract(msg.sender);
        LockedBalance memory lockedBalance = locked[msg.sender];

        require(amount > 0, "zero value");
        require(lockedBalance.amount > 0, "No existing lock found");
        require(lockedBalance.unlockTime > block.timestamp, "Cannot add to expired lock. Withdraw");

        _lock(msg.sender, amount, 0, lockedBalance, LockType.INCREASE_LOCK_AMOUNT);
    }

    function increaseUnlockTime(uint256 unlockTime) public nonReentrant {
        _assertNotContract(msg.sender);
        LockedBalance memory lockedBalance = locked[msg.sender];
        unlockTime = (unlockTime / 1 weeks) * 1 weeks; // Locktime is rounded down to weeks

        require(lockedBalance.unlockTime > block.timestamp, "Lock expired");
        require(lockedBalance.amount > 0, "Nothing is locked");
        require(unlockTime > lockedBalance.unlockTime, "Can only increase lock duration");
        require(unlockTime <= block.timestamp + MAX_TIME, "Voting lock can be 4 years max");

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

        emit Withdrawn(msg.sender, amount, block.timestamp);
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
        return (lockedBalance.amount * (lockedBalance.unlockTime - timestamp)) / MAX_TIME;
    }

    function _totalSupplyAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 weekCursor = (timestamp / 1 weeks) * 1 weeks + 1 weeks;
        uint256 total = 0;
        for (; weekCursor <= timestamp + MAX_TIME; weekCursor += 1 weeks) {
            total += (scheduledUnlock[weekCursor] * (weekCursor - timestamp)) / MAX_TIME;
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
            scheduledUnlock[lockedBalance.unlockTime] -= lockedBalance.amount;
            scheduledUnlock[unlockTime] += lockedBalance.amount + amount;

            // update unlock time per account
            locked[account].unlockTime = unlockTime;
        } else {
            scheduledUnlock[unlockTime] += amount;
        }

        // update locked amount per account
        locked[account].amount = lockedBalance.amount + amount;

        if (amount != 0) {
            IERC20(token).transferFrom(account, address(this), amount);
        }

        emit Locked(account, amount, unlockTime, lockType, block.timestamp);
    }
}
