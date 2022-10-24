// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./VotingEscrowCheckpoint.sol";
import "../utils/CoreUtility.sol";
import "../utils/ManagedPausable.sol";
import "../interfaces/IVotingEscrow.sol";
import "../utils/ProxyUtility.sol";

import "../anyswap/AnyCallAppBase.sol";
import "../anyswap/AnyswapChessPool.sol";
import "../interfaces/IAnyswapV6ERC20.sol";

contract VotingEscrowV3 is
    IVotingEscrow,
    OwnableUpgradeable,
    ReentrancyGuard,
    CoreUtility,
    VotingEscrowCheckpoint,
    ManagedPausable,
    ProxyUtility,
    AnyCallAppBase
{
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[29] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    event LockCreated(address indexed account, uint256 amount, uint256 unlockTime);

    event AmountIncreased(address indexed account, uint256 increasedAmount);

    event AmountDecreased(address indexed account, uint256 decreasedAmount);

    event UnlockTimeIncreased(address indexed account, uint256 newUnlockTime);

    event Withdrawn(address indexed account, uint256 amount);

    event CrossChainSent(
        address indexed account,
        uint256 toChainID,
        uint256 amount,
        uint256 unlockTime
    );

    event CrossChainReceived(
        address indexed account,
        uint256 fromChainID,
        uint256 amount,
        uint256 newUnlockTime
    );

    event CrossChainVotingEscrowUpdated(uint256 chainID, address votingEscrow);

    uint8 public constant decimals = 18;

    uint256 public constant MIN_CROSS_CHAIN_SENDER_LOCK_PERIOD = 4 weeks;
    uint256 public constant MIN_CROSS_CHAIN_RECEIVER_LOCK_PERIOD = 3 weeks;

    address public immutable override token;

    /// @notice Address of AnyswapChessPool (on BNB Chain) or AnyswapChess (on other chains).
    address public immutable anyswapChess;

    string public name;
    string public symbol;

    address public addressWhitelist;

    mapping(address => LockedBalance) public locked;

    /// @notice Mapping of unlockTime => total amount that will be unlocked at unlockTime
    mapping(uint256 => uint256) public scheduledUnlock;

    /// @notice max lock time allowed at the moment
    uint256 public maxTimeAllowed;

    /// @notice Contract to be called when an account's locked CHESS is decreased
    address public callback;

    /// @notice Amount of Chess locked now. Expired locks are not included.
    uint256 public totalLocked;

    /// @notice Total veCHESS at the end of the last checkpoint's week
    uint256 public nextWeekSupply;

    /// @notice Mapping of week => vote-locked chess total supplies
    ///
    ///         Key is the start timestamp of a week on each Thursday. Value is
    ///         vote-locked chess total supplies captured at the start of each week
    mapping(uint256 => uint256) public veSupplyPerWeek;

    /// @notice Start timestamp of the trading week in which the last checkpoint is made
    uint256 public checkpointWeek;

    /// @notice Mapping of chain ID => VotingEscrow address on that chain
    mapping(uint256 => address) public crossChainVotingEscrows;

    constructor(
        address token_,
        uint256 maxTime_,
        address anyswapChess_,
        address anyCallProxy_
    ) public VotingEscrowCheckpoint(maxTime_) AnyCallAppBase(anyCallProxy_, true, true) {
        token = token_;
        anyswapChess = anyswapChess_;
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
        require(maxTimeAllowed_ <= _maxTime, "Cannot exceed max time");
        maxTimeAllowed = maxTimeAllowed_;
        _initializeV2(msg.sender, name_, symbol_);
    }

    /// @dev Initialize the part added in V2. If this contract is upgraded from the previous
    ///      version, call `upgradeToAndCall` of the proxy and put a call to this function
    ///      in the `data` argument.
    ///
    ///      In the previous version, name and symbol were not correctly initialized via proxy.
    function initializeV2(
        address pauser_,
        string memory name_,
        string memory symbol_
    ) external onlyProxyAdmin {
        _initializeV2(pauser_, name_, symbol_);
    }

    function _initializeV2(
        address pauser_,
        string memory name_,
        string memory symbol_
    ) private {
        _initializeManagedPausable(pauser_);
        require(bytes(name).length == 0 && bytes(symbol).length == 0);
        name = name_;
        symbol = symbol_;

        // Initialize totalLocked, nextWeekSupply and checkpointWeek
        uint256 nextWeek = _endOfWeek(block.timestamp);
        uint256 totalLocked_ = 0;
        uint256 nextWeekSupply_ = 0;
        for (
            uint256 weekCursor = nextWeek;
            weekCursor <= nextWeek + _maxTime;
            weekCursor += 1 weeks
        ) {
            totalLocked_ = totalLocked_.add(scheduledUnlock[weekCursor]);
            nextWeekSupply_ = nextWeekSupply_.add(
                (scheduledUnlock[weekCursor].mul(weekCursor - nextWeek)) / _maxTime
            );
        }
        totalLocked = totalLocked_;
        nextWeekSupply = nextWeekSupply_;
        checkpointWeek = nextWeek - 1 weeks;
    }

    function maxTime() external view override returns (uint256) {
        return _maxTime;
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
        return lockedBalance.unlockTime.sub(threshold.mul(_maxTime).div(lockedBalance.amount));
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balanceOfAtTimestamp(account, block.timestamp);
    }

    function totalSupply() external view override returns (uint256) {
        return _veTotalSupply(scheduledUnlock, checkpointWeek, nextWeekSupply, totalLocked);
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

        _checkpointAndUpdateLock(0, 0, amount, unlockTime);
        locked[msg.sender].unlockTime = unlockTime;
        locked[msg.sender].amount = amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit LockCreated(msg.sender, amount, unlockTime);
    }

    function increaseAmount(address account, uint256 amount) external nonReentrant whenNotPaused {
        LockedBalance memory lockedBalance = locked[account];
        require(amount > 0, "Zero value");
        require(lockedBalance.unlockTime > block.timestamp, "Cannot add to expired lock");

        uint256 newAmount = lockedBalance.amount.add(amount);
        _checkpointAndUpdateLock(
            lockedBalance.amount,
            lockedBalance.unlockTime,
            newAmount,
            lockedBalance.unlockTime
        );
        locked[account].amount = newAmount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
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

        _checkpointAndUpdateLock(
            lockedBalance.amount,
            lockedBalance.unlockTime,
            lockedBalance.amount,
            unlockTime
        );
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

        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Transfer locked CHESS to the VotingEscrow on another chain. User should pay cross
    ///         chain fee in native currency (e.g. ETH on Ethereum) when calling this function.
    ///         Exact fee amount can be queried from the AnyCall proxy contract, i.e.
    ///         `IAnyCallV6Proxy(thisContract.anyCallProxy()).calcSrcFees(thisContract, toChainID, 96)`.
    /// @param amount Amount of locked CHESS
    /// @param toChainID Target chain ID
    function veChessCrossChain(uint256 amount, uint256 toChainID)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        LockedBalance memory lockedBalance = locked[msg.sender];
        require(amount > 0, "Zero value");
        require(
            lockedBalance.unlockTime > block.timestamp + MIN_CROSS_CHAIN_SENDER_LOCK_PERIOD,
            "Lock period too short"
        );

        uint256 newAmount = lockedBalance.amount.sub(amount);
        _checkpointAndUpdateLock(
            lockedBalance.amount,
            lockedBalance.unlockTime,
            newAmount,
            lockedBalance.unlockTime
        );
        locked[msg.sender].amount = newAmount;

        // Deposit CHESS to AnySwap pool
        address underlying = IAnyswapV6ERC20(anyswapChess).underlying();
        if (underlying != address(0)) {
            // anyswapChess is an AnyswapChessPool contract
            require(token == underlying);
            IERC20(token).safeTransfer(anyswapChess, amount);
        } else {
            // anyswapChess is an AnyswapChess contract
            IAnyswapV6ERC20(anyswapChess).burn(address(this), amount);
        }

        address to = crossChainVotingEscrows[toChainID];
        require(to != address(0), "Unknown chain ID");
        _anyCall(to, toChainID, abi.encode(msg.sender, amount, lockedBalance.unlockTime));

        if (callback != address(0)) {
            IVotingEscrowCallback(callback).syncWithVotingEscrow(msg.sender);
        }

        // Unlock time can only be reset after the callback is invoked, because some veCHESS-related
        // contracts won't refresh the user's locked balance in `syncWithVotingEscrow()` if
        // unlock time is zero.
        if (newAmount == 0) {
            locked[msg.sender].unlockTime = 0;
        }

        emit AmountDecreased(msg.sender, amount);
        emit CrossChainSent(msg.sender, toChainID, amount, lockedBalance.unlockTime);
    }

    function _checkAnyExecuteFrom(address from, uint256 fromChainID)
        internal
        override
        returns (bool)
    {
        return from == crossChainVotingEscrows[fromChainID];
    }

    function _checkAnyFallbackTo(address to, uint256 fromChainID) internal override returns (bool) {
        return to == crossChainVotingEscrows[fromChainID];
    }

    /// @dev Receive cross chain veCHESS transfer.
    function _anyExecute(uint256 fromChainID, bytes calldata data) internal override {
        (address account, uint256 amount, uint256 unlockTime) =
            abi.decode(data, (address, uint256, uint256));
        _receiveCrossChain(account, amount, unlockTime, fromChainID);
    }

    /// @dev When `veChessCrossChain` failed, this function is called by the anyCall proxy
    ///      to add locked CHESS back to the account.
    function _anyFallback(bytes memory data) internal override {
        (address account, uint256 amount, uint256 unlockTime) =
            abi.decode(data, (address, uint256, uint256));
        _receiveCrossChain(account, amount, unlockTime, 0);
    }

    function _receiveCrossChain(
        address account,
        uint256 amount,
        uint256 unlockTime,
        uint256 fromChainID
    ) private nonReentrant {
        require(
            unlockTime + 1 weeks == _endOfWeek(unlockTime),
            "Unlock time must be end of a week"
        );
        LockedBalance memory lockedBalance = locked[account];
        if (lockedBalance.amount == 0) {
            require(
                !Address.isContract(account) ||
                    (addressWhitelist != address(0) &&
                        IAddressWhitelist(addressWhitelist).check(account)),
                "Smart contract depositors not allowed"
            );
        }
        uint256 newAmount = lockedBalance.amount.add(amount);
        uint256 newUnlockTime =
            lockedBalance.unlockTime.max(unlockTime).max(
                _endOfWeek(block.timestamp) + MIN_CROSS_CHAIN_RECEIVER_LOCK_PERIOD
            );
        _checkpointAndUpdateLock(
            lockedBalance.amount,
            lockedBalance.unlockTime,
            newAmount,
            newUnlockTime
        );
        locked[account].amount = newAmount;
        locked[account].unlockTime = newUnlockTime;

        // Withdraw CHESS from AnySwap pool
        address underlying = IAnyswapV6ERC20(anyswapChess).underlying();
        if (underlying != address(0)) {
            // anyswapChess is an AnyswapChessPool contract
            require(token == underlying);
            AnyswapChessPool(anyswapChess).withdrawUnderlying(amount);
        } else {
            // anyswapChess is an AnyswapChess contract
            IAnyswapV6ERC20(anyswapChess).mint(address(this), amount);
        }
        emit AmountIncreased(account, amount);
        if (newUnlockTime != lockedBalance.unlockTime) {
            emit UnlockTimeIncreased(account, newUnlockTime);
        }
        emit CrossChainReceived(account, fromChainID, amount, newUnlockTime);
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

    function updateCrossChainVotingEscrow(uint256 chainID, address votingEscrow)
        external
        onlyOwner
    {
        crossChainVotingEscrows[chainID] = votingEscrow;
        emit CrossChainVotingEscrowUpdated(chainID, votingEscrow);
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
        return (lockedBalance.amount.mul(lockedBalance.unlockTime - timestamp)) / _maxTime;
    }

    function _totalSupplyAtTimestamp(uint256 timestamp) private view returns (uint256) {
        uint256 weekCursor = _endOfWeek(timestamp);
        uint256 total = 0;
        for (; weekCursor <= timestamp + _maxTime; weekCursor += 1 weeks) {
            total = total.add((scheduledUnlock[weekCursor].mul(weekCursor - timestamp)) / _maxTime);
        }
        return total;
    }

    /// @dev Pre-conditions:
    ///
    ///      - `newAmount > 0`
    ///      - `newUnlockTime > block.timestamp`
    ///      - `newUnlockTime + 1 weeks == _endOfWeek(newUnlockTime)`, i.e. aligned to a trading week
    ///
    ///      The latter two conditions gaurantee that `newUnlockTime` is no smaller than
    ///      `_endOfWeek(block.timestamp)`.
    function _checkpointAndUpdateLock(
        uint256 oldAmount,
        uint256 oldUnlockTime,
        uint256 newAmount,
        uint256 newUnlockTime
    ) private {
        uint256 newNextWeekSupply;
        uint256 newTotalLocked;
        (checkpointWeek, newNextWeekSupply, newTotalLocked) = _veCheckpoint(
            scheduledUnlock,
            checkpointWeek,
            nextWeekSupply,
            totalLocked,
            veSupplyPerWeek
        );
        (nextWeekSupply, totalLocked) = _veUpdateLock(
            newNextWeekSupply,
            newTotalLocked,
            oldAmount,
            oldUnlockTime,
            newAmount,
            newUnlockTime,
            scheduledUnlock
        );
    }

    function updateMaxTimeAllowed(uint256 newMaxTimeAllowed) external onlyOwner {
        require(newMaxTimeAllowed <= _maxTime, "Cannot exceed max time");
        require(newMaxTimeAllowed > maxTimeAllowed, "Cannot shorten max time allowed");
        maxTimeAllowed = newMaxTimeAllowed;
    }

    /// @notice Recalculate `nextWeekSupply` from scratch. This function eliminates accumulated
    ///         rounding errors in `nextWeekSupply`, which is incrementally updated in
    ///         `createLock`, `increaseAmount` and `increaseUnlockTime`. It is almost
    ///         never required.
    /// @dev Search "rounding error" in test cases for details about the rounding errors.
    function calibrateSupply() external {
        uint256 nextWeek = checkpointWeek + 1 weeks;
        nextWeekSupply = _totalSupplyAtTimestamp(nextWeek);
    }
}
