// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../../utils/SafeDecimalMath.sol";
import "../../utils/CoreUtility.sol";
import "../../utils/ManagedPausable.sol";

import "../interfaces/IFund.sol";
import "../../interfaces/IChessController.sol";
import "../../interfaces/IChessSchedule.sol";
import "../interfaces/ITrancheIndex.sol";
import "../interfaces/IPrimaryMarketV2.sol";
import "../../interfaces/IVotingEscrow.sol";

/// @notice Chess locking snapshot used in calculating working balance of an account.
/// @param veProportion The account's veCHESS divided by the total veCHESS supply.
/// @param veLocked Locked CHESS and unlock time, which is synchronized from VotingEscrow.
struct VESnapshot {
    uint256 veProportion;
    IVotingEscrow.LockedBalance veLocked;
}

abstract contract StakingV2 is ITrancheIndex, CoreUtility, ManagedPausable {
    /// @dev Reserved storage slots for future sibling contract upgrades
    uint256[29] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event Deposited(uint256 tranche, address account, uint256 amount);
    event Withdrawn(uint256 tranche, address account, uint256 amount);

    uint256 private constant MAX_ITERATIONS = 500;

    uint256 private constant REWARD_WEIGHT_A = 4;
    uint256 private constant REWARD_WEIGHT_B = 2;
    uint256 private constant REWARD_WEIGHT_M = 3;
    uint256 private constant MAX_BOOSTING_FACTOR = 3e18;
    uint256 private constant MAX_BOOSTING_FACTOR_MINUS_ONE = MAX_BOOSTING_FACTOR - 1e18;

    /// @dev Maximum fraction of veCHESS that can be used to boost Token M.
    uint256 private constant MAX_BOOSTING_POWER_M = 0.5e18;

    IFund public immutable fund;
    IERC20 private immutable tokenM;
    IERC20 private immutable tokenA;
    IERC20 private immutable tokenB;

    /// @notice The Chess release schedule contract.
    IChessSchedule public immutable chessSchedule;

    uint256 public immutable guardedLaunchStart;

    uint256 private _rate;

    /// @notice The controller contract.
    IChessController public immutable chessController;

    /// @notice Quote asset for the exchange. Each exchange only handles one quote asset
    address public immutable quoteAssetAddress;

    /// @dev Total amount of user shares, i.e. sum of all entries in `_availableBalances` and
    ///      `_lockedBalances`. Note that these values can be smaller than the amount of
    ///      share tokens held by this contract, because shares locked in unsettled trades
    ///      are not included in total supplies or any user's balance.
    uint256[TRANCHE_COUNT] private _totalSupplies;

    /// @dev Rebalance version of `_totalSupplies`.
    uint256 private _totalSupplyVersion;

    /// @dev Amount of shares that can be withdrawn or traded by each user.
    mapping(address => uint256[TRANCHE_COUNT]) private _availableBalances;

    /// @dev Amount of shares that are locked in ask orders.
    mapping(address => uint256[TRANCHE_COUNT]) private _lockedBalances;

    /// @dev Rebalance version mapping for `_availableBalances`.
    mapping(address => uint256) private _balanceVersions;

    /// @dev 1e27 * ∫(rate(t) / totalWeight(t) dt) from the latest rebalance till checkpoint.
    uint256 private _invTotalWeightIntegral;

    /// @dev Final `_invTotalWeightIntegral` before each rebalance.
    ///      These values are accessed in a loop in `_userCheckpoint()` with bounds checking.
    ///      So we store them in a fixed-length array, in order to make compiler-generated
    ///      bounds checking on every access cheaper. The actual length of this array is stored in
    ///      `_historicalIntegralSize` and should be explicitly checked when necessary.
    uint256[65535] private _historicalIntegrals;

    /// @dev Actual length of the `_historicalIntegrals` array, which always equals to the number of
    ///      historical rebalances after `checkpoint()` is called.
    uint256 private _historicalIntegralSize;

    /// @dev Timestamp when checkpoint() is called.
    uint256 private _checkpointTimestamp;

    /// @dev Snapshot of `_invTotalWeightIntegral` per user.
    mapping(address => uint256) private _userIntegrals;

    /// @dev Mapping of account => claimable rewards.
    mapping(address => uint256) private _claimableRewards;

    IVotingEscrow private immutable _votingEscrow;
    uint256 private _workingSupply;
    mapping(address => uint256) private _workingBalances;
    mapping(address => VESnapshot) private _veSnapshots;

    constructor(
        address fund_,
        address chessSchedule_,
        address chessController_,
        address quoteAssetAddress_,
        uint256 guardedLaunchStart_,
        address votingEscrow_
    ) public {
        fund = IFund(fund_);
        tokenM = IERC20(IFund(fund_).tokenM());
        tokenA = IERC20(IFund(fund_).tokenA());
        tokenB = IERC20(IFund(fund_).tokenB());
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
        quoteAssetAddress = quoteAssetAddress_;
        guardedLaunchStart = guardedLaunchStart_;
        _votingEscrow = IVotingEscrow(votingEscrow_);
    }

    function _initializeStaking() internal {
        require(_checkpointTimestamp == 0);
        _checkpointTimestamp = block.timestamp;
        _rate = IChessSchedule(chessSchedule).getRate(block.timestamp);
    }

    function _initializeStakingV2(address pauser_) internal {
        _initializeManagedPausable(pauser_);
        // The contract was just upgraded from an old version without boosting
        _workingSupply = weightedBalance(
            _totalSupplies[TRANCHE_M],
            _totalSupplies[TRANCHE_A],
            _totalSupplies[TRANCHE_B]
        );
    }

    /// @notice Return weight of given balance with respect to rewards.
    /// @param amountM Amount of Token M
    /// @param amountA Amount of Token A
    /// @param amountB Amount of Token B
    /// @return Rewarding weight of the balance
    function weightedBalance(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB
    ) public pure returns (uint256) {
        return
            amountM.mul(REWARD_WEIGHT_M).add(amountA.mul(REWARD_WEIGHT_A)).add(
                amountB.mul(REWARD_WEIGHT_B)
            ) / REWARD_WEIGHT_M;
    }

    function totalSupply(uint256 tranche) external view returns (uint256) {
        uint256 totalSupplyM = _totalSupplies[TRANCHE_M];
        uint256 totalSupplyA = _totalSupplies[TRANCHE_A];
        uint256 totalSupplyB = _totalSupplies[TRANCHE_B];

        uint256 version = _totalSupplyVersion;
        uint256 rebalanceSize = _fundRebalanceSize();
        if (version < rebalanceSize) {
            (totalSupplyM, totalSupplyA, totalSupplyB) = _fundBatchRebalance(
                totalSupplyM,
                totalSupplyA,
                totalSupplyB,
                version,
                rebalanceSize
            );
        }

        if (tranche == TRANCHE_M) {
            return totalSupplyM;
        } else if (tranche == TRANCHE_A) {
            return totalSupplyA;
        } else {
            return totalSupplyB;
        }
    }

    function availableBalanceOf(uint256 tranche, address account) external view returns (uint256) {
        uint256 amountM = _availableBalances[account][TRANCHE_M];
        uint256 amountA = _availableBalances[account][TRANCHE_A];
        uint256 amountB = _availableBalances[account][TRANCHE_B];

        if (tranche == TRANCHE_M) {
            if (amountM == 0 && amountA == 0 && amountB == 0) return 0;
        } else if (tranche == TRANCHE_A) {
            if (amountA == 0) return 0;
        } else {
            if (amountB == 0) return 0;
        }

        uint256 version = _balanceVersions[account];
        uint256 rebalanceSize = _fundRebalanceSize();
        if (version < rebalanceSize) {
            (amountM, amountA, amountB) = _fundBatchRebalance(
                amountM,
                amountA,
                amountB,
                version,
                rebalanceSize
            );
        }

        if (tranche == TRANCHE_M) {
            return amountM;
        } else if (tranche == TRANCHE_A) {
            return amountA;
        } else {
            return amountB;
        }
    }

    function lockedBalanceOf(uint256 tranche, address account) external view returns (uint256) {
        uint256 amountM = _lockedBalances[account][TRANCHE_M];
        uint256 amountA = _lockedBalances[account][TRANCHE_A];
        uint256 amountB = _lockedBalances[account][TRANCHE_B];

        if (tranche == TRANCHE_M) {
            if (amountM == 0 && amountA == 0 && amountB == 0) return 0;
        } else if (tranche == TRANCHE_A) {
            if (amountA == 0) return 0;
        } else {
            if (amountB == 0) return 0;
        }

        uint256 version = _balanceVersions[account];
        uint256 rebalanceSize = _fundRebalanceSize();
        if (version < rebalanceSize) {
            (amountM, amountA, amountB) = _fundBatchRebalance(
                amountM,
                amountA,
                amountB,
                version,
                rebalanceSize
            );
        }

        if (tranche == TRANCHE_M) {
            return amountM;
        } else if (tranche == TRANCHE_A) {
            return amountA;
        } else {
            return amountB;
        }
    }

    function balanceVersion(address account) external view returns (uint256) {
        return _balanceVersions[account];
    }

    function workingSupply() external view returns (uint256) {
        uint256 version = _totalSupplyVersion;
        uint256 rebalanceSize = _fundRebalanceSize();
        if (version < rebalanceSize) {
            (uint256 totalSupplyM, uint256 totalSupplyA, uint256 totalSupplyB) =
                _fundBatchRebalance(
                    _totalSupplies[TRANCHE_M],
                    _totalSupplies[TRANCHE_A],
                    _totalSupplies[TRANCHE_B],
                    version,
                    rebalanceSize
                );
            return weightedBalance(totalSupplyM, totalSupplyA, totalSupplyB);
        } else {
            return _workingSupply;
        }
    }

    function workingBalanceOf(address account) external view returns (uint256) {
        uint256 version = _balanceVersions[account];
        uint256 rebalanceSize = _fundRebalanceSize();
        uint256 workingBalance = _workingBalances[account]; // gas saver
        if (version < rebalanceSize || workingBalance == 0) {
            uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
            uint256[TRANCHE_COUNT] storage locked = _lockedBalances[account];
            uint256 amountM = available[TRANCHE_M].add(locked[TRANCHE_M]);
            uint256 amountA = available[TRANCHE_A].add(locked[TRANCHE_A]);
            uint256 amountB = available[TRANCHE_B].add(locked[TRANCHE_B]);
            if (version < rebalanceSize) {
                (amountM, amountA, amountB) = _fundBatchRebalance(
                    amountM,
                    amountA,
                    amountB,
                    version,
                    rebalanceSize
                );
            }
            return weightedBalance(amountM, amountA, amountB);
        } else {
            return workingBalance;
        }
    }

    function veSnapshotOf(address account) external view returns (VESnapshot memory) {
        return _veSnapshots[account];
    }

    function _fundRebalanceSize() internal view returns (uint256) {
        return fund.getRebalanceSize();
    }

    function _fundDoRebalance(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 index
    )
        internal
        view
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return fund.doRebalance(amountM, amountA, amountB, index);
    }

    function _fundBatchRebalance(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 fromIndex,
        uint256 toIndex
    )
        internal
        view
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return fund.batchRebalance(amountM, amountA, amountB, fromIndex, toIndex);
    }

    /// @dev Deposit to get rewards
    /// @param tranche Tranche of the share
    /// @param amount The amount to deposit
    function deposit(uint256 tranche, uint256 amount) public whenNotPaused {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(msg.sender, rebalanceSize);
        _availableBalances[msg.sender][tranche] = _availableBalances[msg.sender][tranche].add(
            amount
        );
        _totalSupplies[tranche] = _totalSupplies[tranche].add(amount);
        _updateWorkingBalance(msg.sender);

        if (tranche == TRANCHE_M) {
            tokenM.safeTransferFrom(msg.sender, address(this), amount);
        } else if (tranche == TRANCHE_A) {
            tokenA.safeTransferFrom(msg.sender, address(this), amount);
        } else {
            tokenB.safeTransferFrom(msg.sender, address(this), amount);
        }

        emit Deposited(tranche, msg.sender, amount);
    }

    /// @dev Claim settled Token M from the primary market and deposit to get rewards
    /// @param primaryMarket The primary market to claim shares from
    function claimAndDeposit(address primaryMarket) external {
        (uint256 createdShares, ) = IPrimaryMarketV2(primaryMarket).claim(msg.sender);
        deposit(TRANCHE_M, createdShares);
    }

    function claimAndUnwrapAndDeposit(address primaryMarket) external {
        (uint256 createdShares, ) = IPrimaryMarketV2(primaryMarket).claimAndUnwrap(msg.sender);
        deposit(TRANCHE_M, createdShares);
    }

    /// @dev Withdraw
    /// @param tranche Tranche of the share
    /// @param amount The amount to deposit
    function withdraw(uint256 tranche, uint256 amount) external whenNotPaused {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(msg.sender, rebalanceSize);
        _availableBalances[msg.sender][tranche] = _availableBalances[msg.sender][tranche].sub(
            amount,
            "Insufficient balance to withdraw"
        );
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);
        _updateWorkingBalance(msg.sender);

        if (tranche == TRANCHE_M) {
            tokenM.safeTransfer(msg.sender, amount);
        } else if (tranche == TRANCHE_A) {
            tokenA.safeTransfer(msg.sender, amount);
        } else {
            tokenB.safeTransfer(msg.sender, amount);
        }

        emit Withdrawn(tranche, msg.sender, amount);
    }

    /// @notice Transform share balance to a given rebalance version, or to the latest version
    ///         if `targetVersion` is zero.
    /// @param account Account of the balance to rebalance
    /// @param targetVersion The target rebalance version, or zero for the latest version
    function refreshBalance(address account, uint256 targetVersion) external {
        uint256 rebalanceSize = _fundRebalanceSize();
        if (targetVersion == 0) {
            targetVersion = rebalanceSize;
        } else {
            require(targetVersion <= rebalanceSize, "Target version out of bound");
        }
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, targetVersion);
    }

    /// @notice Return claimable rewards of an account till now.
    ///
    ///         This function should be call as a "view" function off-chain to get
    ///         the return value, e.g. using `contract.claimableRewards.call(account)` in web3
    ///         or `contract.callStatic.claimableRewards(account)` in ethers.js.
    /// @param account Address of an account
    /// @return Amount of claimable rewards
    function claimableRewards(address account) external returns (uint256) {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);
        return _claimableRewards[account];
    }

    /// @notice Claim the rewards for an account.
    /// @param account Account to claim its rewards
    function claimRewards(address account) external whenNotPaused {
        require(
            block.timestamp >= guardedLaunchStart + 15 days,
            "Cannot claim during guarded launch"
        );
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);
        _claim(account);
    }

    /// @notice Synchronize an account's locked Chess with `VotingEscrow`
    ///         and update its working balance.
    /// @param account Address of the synchronized account
    function syncWithVotingEscrow(address account) external {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);

        VESnapshot storage veSnapshot = _veSnapshots[account];
        IVotingEscrow.LockedBalance memory newLocked = _votingEscrow.getLockedBalance(account);
        if (
            newLocked.amount != veSnapshot.veLocked.amount ||
            newLocked.unlockTime != veSnapshot.veLocked.unlockTime ||
            newLocked.unlockTime < block.timestamp
        ) {
            veSnapshot.veLocked.amount = newLocked.amount;
            veSnapshot.veLocked.unlockTime = newLocked.unlockTime;
            veSnapshot.veProportion = _votingEscrow.balanceOf(account).divideDecimal(
                _votingEscrow.totalSupply()
            );
        }

        _updateWorkingBalance(account);
    }

    /// @dev Transfer shares from the sender to the contract internally
    /// @param tranche Tranche of the share
    /// @param sender Sender address
    /// @param amount The amount to transfer
    function _tradeAvailable(
        uint256 tranche,
        address sender,
        uint256 amount
    ) internal {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(sender, rebalanceSize);
        _availableBalances[sender][tranche] = _availableBalances[sender][tranche].sub(amount);
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);
        _updateWorkingBalance(sender);
    }

    function _rebalanceAndClearTrade(
        address account,
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 amountVersion
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);
        if (amountVersion < rebalanceSize) {
            (amountM, amountA, amountB) = _fundBatchRebalance(
                amountM,
                amountA,
                amountB,
                amountVersion,
                rebalanceSize
            );
        }
        uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
        if (amountM > 0) {
            available[TRANCHE_M] = available[TRANCHE_M].add(amountM);
            _totalSupplies[TRANCHE_M] = _totalSupplies[TRANCHE_M].add(amountM);
        }
        if (amountA > 0) {
            available[TRANCHE_A] = available[TRANCHE_A].add(amountA);
            _totalSupplies[TRANCHE_A] = _totalSupplies[TRANCHE_A].add(amountA);
        }
        if (amountB > 0) {
            available[TRANCHE_B] = available[TRANCHE_B].add(amountB);
            _totalSupplies[TRANCHE_B] = _totalSupplies[TRANCHE_B].add(amountB);
        }
        _updateWorkingBalance(account);

        return (amountM, amountA, amountB);
    }

    function _lock(
        uint256 tranche,
        address account,
        uint256 amount
    ) internal {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);
        _availableBalances[account][tranche] = _availableBalances[account][tranche].sub(
            amount,
            "Insufficient balance to lock"
        );
        _lockedBalances[account][tranche] = _lockedBalances[account][tranche].add(amount);
    }

    function _rebalanceAndUnlock(
        address account,
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 amountVersion
    ) internal {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);
        if (amountVersion < rebalanceSize) {
            (amountM, amountA, amountB) = _fundBatchRebalance(
                amountM,
                amountA,
                amountB,
                amountVersion,
                rebalanceSize
            );
        }
        uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
        uint256[TRANCHE_COUNT] storage locked = _lockedBalances[account];
        if (amountM > 0) {
            available[TRANCHE_M] = available[TRANCHE_M].add(amountM);
            locked[TRANCHE_M] = locked[TRANCHE_M].sub(amountM);
        }
        if (amountA > 0) {
            available[TRANCHE_A] = available[TRANCHE_A].add(amountA);
            locked[TRANCHE_A] = locked[TRANCHE_A].sub(amountA);
        }
        if (amountB > 0) {
            available[TRANCHE_B] = available[TRANCHE_B].add(amountB);
            locked[TRANCHE_B] = locked[TRANCHE_B].sub(amountB);
        }
    }

    function _tradeLocked(
        uint256 tranche,
        address account,
        uint256 amount
    ) internal {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);
        _lockedBalances[account][tranche] = _lockedBalances[account][tranche].sub(amount);
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);
        _updateWorkingBalance(account);
    }

    /// @dev Transfer claimable rewards to an account. Rewards since the last user checkpoint
    ///      is not included. This function should always be called after `_userCheckpoint()`,
    ///      in order for the user to get all rewards till now.
    /// @param account Address of the account
    function _claim(address account) internal {
        uint256 claimableReward = _claimableRewards[account];
        _claimableRewards[account] = 0;
        chessSchedule.mint(account, claimableReward);
    }

    /// @dev Transform total supplies to the latest rebalance version and make a global reward checkpoint.
    /// @param rebalanceSize The number of existing rebalances. It must be the same as
    ///                       `fund.getRebalanceSize()`.
    function _checkpoint(uint256 rebalanceSize) private {
        uint256 timestamp = _checkpointTimestamp;
        if (timestamp >= block.timestamp) {
            return;
        }

        uint256 integral = _invTotalWeightIntegral;
        uint256 endWeek = _endOfWeek(timestamp);
        uint256 weeklyPercentage =
            chessController.getFundRelativeWeight(address(fund), endWeek - 1 weeks);
        uint256 version = _totalSupplyVersion;
        uint256 rebalanceTimestamp;
        if (version < rebalanceSize) {
            rebalanceTimestamp = fund.getRebalanceTimestamp(version);
        } else {
            rebalanceTimestamp = type(uint256).max;
        }
        uint256 rate = _rate;
        uint256 totalSupplyM = _totalSupplies[TRANCHE_M];
        uint256 totalSupplyA = _totalSupplies[TRANCHE_A];
        uint256 totalSupplyB = _totalSupplies[TRANCHE_B];
        uint256 weight = _workingSupply;
        uint256 timestamp_ = timestamp; // avoid stack too deep

        for (uint256 i = 0; i < MAX_ITERATIONS && timestamp_ < block.timestamp; i++) {
            uint256 endTimestamp = rebalanceTimestamp.min(endWeek).min(block.timestamp);

            if (weight > 0) {
                integral = integral.add(
                    rate
                        .mul(endTimestamp.sub(timestamp_))
                        .multiplyDecimal(weeklyPercentage)
                        .divideDecimalPrecise(weight)
                );
            }

            if (endTimestamp == rebalanceTimestamp) {
                uint256 oldSize = _historicalIntegralSize;
                _historicalIntegrals[oldSize] = integral;
                _historicalIntegralSize = oldSize + 1;

                integral = 0;
                (totalSupplyM, totalSupplyA, totalSupplyB) = _fundDoRebalance(
                    totalSupplyM,
                    totalSupplyA,
                    totalSupplyB,
                    version
                );

                version++;
                // Reset total weight boosting after the first rebalance
                weight = weightedBalance(totalSupplyM, totalSupplyA, totalSupplyB);

                if (version < rebalanceSize) {
                    rebalanceTimestamp = fund.getRebalanceTimestamp(version);
                } else {
                    rebalanceTimestamp = type(uint256).max;
                }
            }
            if (endTimestamp == endWeek) {
                rate = chessSchedule.getRate(endWeek);
                weeklyPercentage = chessController.getFundRelativeWeight(address(fund), endWeek);
                endWeek += 1 weeks;
            }

            timestamp_ = endTimestamp;
        }

        _checkpointTimestamp = block.timestamp;
        _invTotalWeightIntegral = integral;
        if (_rate != rate) {
            _rate = rate;
        }
        if (_totalSupplyVersion != rebalanceSize) {
            _totalSupplies[TRANCHE_M] = totalSupplyM;
            _totalSupplies[TRANCHE_A] = totalSupplyA;
            _totalSupplies[TRANCHE_B] = totalSupplyB;
            _totalSupplyVersion = rebalanceSize;
            // Reset total working weight before any boosting if rebalance ever triggered
            _workingSupply = weight;
        }
    }

    /// @dev Transform a user's balance to a given rebalance version and update this user's rewards.
    ///
    ///      In most cases, the target version is the latest version and this function cumulates
    ///      rewards till now. When this function is called from `refreshBalance()`,
    ///      `targetVersion` can be an older version, in which case rewards are cumulated till
    ///      the end of that version (i.e. timestamp of the transaction triggering the rebalance
    ///      with index `targetVersion`).
    ///
    ///      This function should always be called after `_checkpoint()` is called, so that
    ///      the global reward checkpoint is guarenteed up to date.
    /// @param account Account to update
    /// @param targetVersion The target rebalance version
    function _userCheckpoint(address account, uint256 targetVersion) private {
        uint256 oldVersion = _balanceVersions[account];
        if (oldVersion > targetVersion) {
            return;
        }
        uint256 userIntegral = _userIntegrals[account];
        uint256 integral;
        // This scope is to avoid the "stack too deep" error.
        {
            // We assume that this function is always called immediately after `_checkpoint()`,
            // which guarantees that `_historicalIntegralSize` equals to the number of historical
            // rebalances.
            uint256 rebalanceSize = _historicalIntegralSize;
            integral = targetVersion == rebalanceSize
                ? _invTotalWeightIntegral
                : _historicalIntegrals[targetVersion];
        }
        if (userIntegral == integral && oldVersion == targetVersion) {
            // Return immediately when the user's rewards have already been updated to
            // the target version.
            return;
        }

        uint256 rewards = _claimableRewards[account];
        uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
        uint256[TRANCHE_COUNT] storage locked = _lockedBalances[account];
        uint256 weight = _workingBalances[account];
        if (weight == 0) {
            // Loading available and locked is repeated to avoid "stake too deep" error.
            weight = weightedBalance(
                available[TRANCHE_M].add(locked[TRANCHE_M]),
                available[TRANCHE_A].add(locked[TRANCHE_A]),
                available[TRANCHE_B].add(locked[TRANCHE_B])
            );
            if (weight > 0) {
                // The contract was just upgraded from an old version without boosting
                _workingBalances[account] = weight;
            }
        }
        uint256 availableM = available[TRANCHE_M];
        uint256 availableA = available[TRANCHE_A];
        uint256 availableB = available[TRANCHE_B];
        uint256 lockedM = locked[TRANCHE_M];
        uint256 lockedA = locked[TRANCHE_A];
        uint256 lockedB = locked[TRANCHE_B];
        for (uint256 i = oldVersion; i < targetVersion; i++) {
            rewards = rewards.add(
                weight.multiplyDecimalPrecise(_historicalIntegrals[i].sub(userIntegral))
            );
            if (availableM != 0 || availableA != 0 || availableB != 0) {
                (availableM, availableA, availableB) = _fundDoRebalance(
                    availableM,
                    availableA,
                    availableB,
                    i
                );
            }
            if (lockedM != 0 || lockedA != 0 || lockedB != 0) {
                (lockedM, lockedA, lockedB) = _fundDoRebalance(lockedM, lockedA, lockedB, i);
            }
            userIntegral = 0;

            // Reset per-user weight boosting after the first rebalance
            weight = weightedBalance(
                availableM.add(lockedM),
                availableA.add(lockedA),
                availableB.add(lockedB)
            );
        }
        rewards = rewards.add(weight.multiplyDecimalPrecise(integral.sub(userIntegral)));
        address account_ = account; // Fix the "stack too deep" error
        _claimableRewards[account_] = rewards;
        _userIntegrals[account_] = integral;

        if (oldVersion < targetVersion) {
            if (available[TRANCHE_M] != availableM) {
                available[TRANCHE_M] = availableM;
            }
            if (available[TRANCHE_A] != availableA) {
                available[TRANCHE_A] = availableA;
            }
            if (available[TRANCHE_B] != availableB) {
                available[TRANCHE_B] = availableB;
            }
            if (locked[TRANCHE_M] != lockedM) {
                locked[TRANCHE_M] = lockedM;
            }
            if (locked[TRANCHE_A] != lockedA) {
                locked[TRANCHE_A] = lockedA;
            }
            if (locked[TRANCHE_B] != lockedB) {
                locked[TRANCHE_B] = lockedB;
            }
            _balanceVersions[account_] = targetVersion;
            _workingBalances[account_] = weight;
        }
    }

    /// @dev Calculate working balance, which depends on the amount of staked tokens and veCHESS.
    ///      Before this function is called, both `_checkpoint()` and `_userCheckpoint(account)`
    ///      should be called to update `_workingSupply` and `_workingBalances[account]` to
    ///      the latest rebalance version.
    /// @param account User address
    function _updateWorkingBalance(address account) private {
        uint256 weightedSupply =
            weightedBalance(
                _totalSupplies[TRANCHE_M],
                _totalSupplies[TRANCHE_A],
                _totalSupplies[TRANCHE_B]
            );
        uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
        uint256[TRANCHE_COUNT] storage locked = _lockedBalances[account];
        // Assume weightedBalance(x, 0, 0) always equal to x
        uint256 weightedM = available[TRANCHE_M].add(locked[TRANCHE_M]);
        uint256 weightedAB =
            weightedBalance(
                0,
                available[TRANCHE_A].add(locked[TRANCHE_A]),
                available[TRANCHE_B].add(locked[TRANCHE_B])
            );

        uint256 newWorkingBalance = weightedAB.add(weightedM);
        uint256 veProportion = _veSnapshots[account].veProportion;
        if (veProportion > 0 && _veSnapshots[account].veLocked.unlockTime > block.timestamp) {
            uint256 boostingPower = weightedSupply.multiplyDecimal(veProportion);
            if (boostingPower <= weightedAB) {
                newWorkingBalance = newWorkingBalance.add(
                    boostingPower.multiplyDecimal(MAX_BOOSTING_FACTOR_MINUS_ONE)
                );
            } else {
                uint256 boostingPowerM =
                    (boostingPower - weightedAB)
                        .min(boostingPower.multiplyDecimal(MAX_BOOSTING_POWER_M))
                        .min(weightedM);
                newWorkingBalance = newWorkingBalance.add(
                    weightedAB.add(boostingPowerM).multiplyDecimal(MAX_BOOSTING_FACTOR_MINUS_ONE)
                );
            }
        }

        _workingSupply = _workingSupply.sub(_workingBalances[account]).add(newWorkingBalance);
        _workingBalances[account] = newWorkingBalance;
    }
}
