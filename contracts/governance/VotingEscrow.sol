// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/IVotingEscrow.sol";

interface IAddressWhitelist {
    function check(address account) external view returns (bool);
}

contract VotingEscrow is IVotingEscrow, ReentrancyGuard, Ownable {
    using SafeMath for uint256;

    event LockCreated(address indexed account, uint256 amount, uint256 unlockTime);

    event AmountIncreased(address indexed account, uint256 increasedAmount);

    event UnlockTimeIncreased(address indexed account, uint256 newUnlockTime);

    event Withdrawn(address indexed account, uint256 amount);

    uint256 public immutable override maxTime;

    address public immutable override token;

    string public name;
    string public symbol;

    address public addressWhitelist;

    mapping(address => LockedBalance) public locked;

    /// @notice Mapping of unlockTime => total amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;

    constructor(
        address token_,
        address addressWhitelist_,
        string memory name_,
        string memory symbol_,
        uint256 maxTime_
    ) public Ownable() {
        name = name_;
        symbol = symbol_;
        token = token_;
        addressWhitelist = addressWhitelist_;
        maxTime = maxTime_;
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

    function createLock(uint256 amount, uint256 unlockTime) external nonReentrant {
        _assertNotContract(msg.sender);

        unlockTime = (unlockTime / 1 weeks) * 1 weeks; // Locktime is rounded down to weeks
        LockedBalance memory lockedBalance = locked[msg.sender];

        require(amount > 0, "Zero value");
        require(lockedBalance.amount == 0, "Withdraw old tokens first");
        require(unlockTime > block.timestamp, "Can only lock until time in the future");
        require(unlockTime <= block.timestamp + maxTime, "Voting lock cannot exceed max lock time");

        scheduledUnlock[unlockTime] = scheduledUnlock[unlockTime].add(amount);
        locked[msg.sender].unlockTime = unlockTime;
        locked[msg.sender].amount = amount;

        IERC20(token).transferFrom(msg.sender, address(this), amount);

        emit LockCreated(msg.sender, amount, unlockTime);
    }

    function increaseAmount(address account, uint256 amount) external nonReentrant {
        LockedBalance memory lockedBalance = locked[account];

        require(amount > 0, "Zero value");
        require(lockedBalance.unlockTime > block.timestamp, "Cannot add to expired lock");

        scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime].add(
            amount
        );
        locked[account].amount = lockedBalance.amount.add(amount);

        IERC20(token).transferFrom(msg.sender, address(this), amount);

        emit AmountIncreased(account, amount);
    }

    function increaseUnlockTime(uint256 unlockTime) external nonReentrant {
        LockedBalance memory lockedBalance = locked[msg.sender];
        unlockTime = (unlockTime / 1 weeks) * 1 weeks; // Locktime is rounded down to weeks

        require(lockedBalance.unlockTime > block.timestamp, "Lock expired");
        require(unlockTime > lockedBalance.unlockTime, "Can only increase lock duration");
        require(unlockTime <= block.timestamp + maxTime, "Voting lock cannot exceed max lock time");

        scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime].sub(
            lockedBalance.amount
        );
        scheduledUnlock[unlockTime] = scheduledUnlock[unlockTime].add(lockedBalance.amount);
        locked[msg.sender].unlockTime = unlockTime;

        emit UnlockTimeIncreased(msg.sender, unlockTime);
    }

    function withdraw() external nonReentrant {
        LockedBalance memory lockedBalance = locked[msg.sender];
        require(block.timestamp >= lockedBalance.unlockTime, "The lock is not expired");
        uint256 amount = uint256(lockedBalance.amount);

        lockedBalance.unlockTime = 0;
        lockedBalance.amount = 0;
        locked[msg.sender] = lockedBalance;

        IERC20(token).transfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    function updateAddressWhitelist(address newWhitelist) external onlyOwner {
        require(
            newWhitelist == address(0) || Address.isContract(newWhitelist),
            "Smart contract whitelist has to be null or a contract"
        );
        addressWhitelist = newWhitelist;
    }

    function _assertNotContract(address account) private view {
        if (Address.isContract(account)) {
            if (
                addressWhitelist != address(0) && IAddressWhitelist(addressWhitelist).check(account)
            ) {
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
        require(timestamp >= block.timestamp, "Must be current or future time");
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
}
