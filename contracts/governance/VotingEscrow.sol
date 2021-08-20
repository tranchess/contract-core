// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../utils/CoreUtility.sol";
import "../utils/ManagedPausable.sol";
import "../interfaces/IVotingEscrow.sol";

interface IAddressWhitelist {
    function check(address account) external view returns (bool);
}

interface IVotingEscrowCallback {
    function syncWithVotingEscrow(address account) external;
}

contract VotingEscrow is
    IVotingEscrow,
    OwnableUpgradeable,
    ReentrancyGuard,
    CoreUtility,
    ManagedPausable
{
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[29] private _reservedSlots;

    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    event LockCreated(address indexed account, uint256 amount, uint256 unlockTime);

    event AmountIncreased(address indexed account, uint256 increasedAmount);

    event UnlockTimeIncreased(address indexed account, uint256 newUnlockTime);

    event Withdrawn(address indexed account, uint256 amount);

    uint8 public constant decimals = 18;

    uint256 public immutable override maxTime;

    address public immutable override token;

    string public name;
    string public symbol;

    address public addressWhitelist;

    mapping(address => LockedBalance) public locked;

    /// @notice Mapping of unlockTime => total amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;

    /// @notice max lock time allowed at the moment
    uint256 public maxTimeAllowed;

    /// @notice Contract to be call when an account's locked CHESS is updated
    address public callback;

    constructor(address token_, uint256 maxTime_) public {
        token = token_;
        maxTime = maxTime_;
    }

    /// @dev Initialize the contract. The contract is designed to be used with OpenZeppelin's
    ///      `TransparentUpgradeableProxy`. This function should be called by the proxy's
    ///      constructor (via the `_data` argument).
    function initialize(
        string memory name_,
        string memory symbol_,
        uint256 maxTimeAllowed_
    ) external initializer {
        __Ownable_init();
        require(maxTimeAllowed_ <= maxTime, "Cannot exceed max time");
        maxTimeAllowed = maxTimeAllowed_;
        initializeV2(name_, symbol_);
    }

    /// @dev Initialize the part added in V2. If this contract is upgraded from the previous
    ///      version, call `upgradeToAndCall` of the proxy and put a call to this function
    ///      in the `data` argument.
    ///
    ///      In the previous version, name and symbol were not correctly initialized via proxy.
    function initializeV2(string memory name_, string memory symbol_) public {
        _initializeManagedPausable();
        require(bytes(name).length == 0 && bytes(symbol).length == 0);
        name = name_;
        symbol = symbol_;
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

    function createLock(uint256 amount, uint256 unlockTime) external nonReentrant whenNotPaused {
        _assertNotContract();
        require(
            unlockTime + 1 weeks == _endOfWeek(unlockTime),
            "Unlock time must be end of a week"
        );

        LockedBalance memory lockedBalance = locked[msg.sender];

        require(amount > 0, "Zero value");
        require(lockedBalance.amount == 0, "Withdraw old tokens first");
        require(unlockTime > block.timestamp, "Can only lock until time in the future");
        require(
            unlockTime <= block.timestamp + maxTimeAllowed,
            "Voting lock cannot exceed max lock time"
        );

        scheduledUnlock[unlockTime] = scheduledUnlock[unlockTime].add(amount);
        locked[msg.sender].unlockTime = unlockTime;
        locked[msg.sender].amount = amount;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        if (callback != address(0)) {
            IVotingEscrowCallback(callback).syncWithVotingEscrow(msg.sender);
        }

        emit LockCreated(msg.sender, amount, unlockTime);
    }

    function increaseAmount(address account, uint256 amount) external nonReentrant whenNotPaused {
        LockedBalance memory lockedBalance = locked[account];

        require(amount > 0, "Zero value");
        require(lockedBalance.unlockTime > block.timestamp, "Cannot add to expired lock");

        scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime].add(
            amount
        );
        locked[account].amount = lockedBalance.amount.add(amount);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        if (callback != address(0)) {
            IVotingEscrowCallback(callback).syncWithVotingEscrow(msg.sender);
        }

        emit AmountIncreased(account, amount);
    }

    function increaseUnlockTime(uint256 unlockTime) external nonReentrant whenNotPaused {
        require(
            unlockTime + 1 weeks == _endOfWeek(unlockTime),
            "Unlock time must be end of a week"
        );
        LockedBalance memory lockedBalance = locked[msg.sender];

        require(lockedBalance.unlockTime > block.timestamp, "Lock expired");
        require(unlockTime > lockedBalance.unlockTime, "Can only increase lock duration");
        require(
            unlockTime <= block.timestamp + maxTimeAllowed,
            "Voting lock cannot exceed max lock time"
        );

        scheduledUnlock[lockedBalance.unlockTime] = scheduledUnlock[lockedBalance.unlockTime].sub(
            lockedBalance.amount
        );
        scheduledUnlock[unlockTime] = scheduledUnlock[unlockTime].add(lockedBalance.amount);
        locked[msg.sender].unlockTime = unlockTime;

        if (callback != address(0)) {
            IVotingEscrowCallback(callback).syncWithVotingEscrow(msg.sender);
        }

        emit UnlockTimeIncreased(msg.sender, unlockTime);
    }

    function withdraw() external nonReentrant whenNotPaused {
        LockedBalance memory lockedBalance = locked[msg.sender];
        require(block.timestamp >= lockedBalance.unlockTime, "The lock is not expired");
        uint256 amount = uint256(lockedBalance.amount);

        lockedBalance.unlockTime = 0;
        lockedBalance.amount = 0;
        locked[msg.sender] = lockedBalance;

        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    function updateAddressWhitelist(address newWhitelist) external onlyOwner {
        require(
            newWhitelist == address(0) || Address.isContract(newWhitelist),
            "Must be null or a contract"
        );
        addressWhitelist = newWhitelist;
    }

    function updateCallback(address newCallback) external onlyOwner {
        require(
            newCallback == address(0) || Address.isContract(newCallback),
            "Must be null or a contract"
        );
        callback = newCallback;
    }

    function _assertNotContract() private view {
        if (msg.sender != tx.origin) {
            if (
                addressWhitelist != address(0) &&
                IAddressWhitelist(addressWhitelist).check(msg.sender)
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
        uint256 weekCursor = _endOfWeek(timestamp);
        uint256 total = 0;
        for (; weekCursor <= timestamp + maxTime; weekCursor += 1 weeks) {
            total = total.add((scheduledUnlock[weekCursor].mul(weekCursor - timestamp)) / maxTime);
        }
        return total;
    }

    function updateMaxTimeAllowed(uint256 newMaxTimeAllowed) external onlyOwner {
        require(newMaxTimeAllowed <= maxTime, "Cannot exceed max time");
        require(newMaxTimeAllowed > maxTimeAllowed, "Cannot shorten max time allowed");
        maxTimeAllowed = newMaxTimeAllowed;
    }
}
