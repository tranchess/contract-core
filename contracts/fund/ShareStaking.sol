// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/CoreUtility.sol";
import "../utils/ManagedPausable.sol";

import "../interfaces/IFundV3.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IChessSchedule.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IVotingEscrow.sol";

/// @notice Chess locking snapshot used in calculating working balance of an account.
/// @param veProportion The account's veCHESS divided by the total veCHESS supply.
/// @param veLocked Locked CHESS and unlock time, which is synchronized from VotingEscrow.
struct VESnapshot {
    uint256 veProportion;
    IVotingEscrow.LockedBalance veLocked;
}

contract ShareStaking is ITrancheIndexV2, CoreUtility {
    /// @dev Reserved storage slots for future sibling contract upgrades
    uint256[32] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event Deposited(uint256 tranche, address account, uint256 amount);
    event Withdrawn(uint256 tranche, address account, uint256 amount);

    uint256 private constant MAX_ITERATIONS = 500;

    uint256 private constant REWARD_WEIGHT_B = 4;
    uint256 private constant REWARD_WEIGHT_R = 2;
    uint256 private constant REWARD_WEIGHT_Q = 3;
    uint256 private constant MAX_BOOSTING_FACTOR = 3e18;
    uint256 private constant MAX_BOOSTING_FACTOR_MINUS_ONE = MAX_BOOSTING_FACTOR - 1e18;

    /// @dev Maximum fraction of veCHESS that can be used to boost QUEEN.
    uint256 private constant MAX_BOOSTING_POWER_Q = 0.5e18;

    IFundV3 public immutable fund;

    /// @notice The Chess release schedule contract.
    IChessSchedule public immutable chessSchedule;

    /// @notice The controller contract.
    IChessController public immutable chessController;

    IVotingEscrow private immutable _votingEscrow;

    uint256 private _rate;

    /// @dev Total amount of user shares, i.e. sum of all entries in `_balances`.
    uint256[TRANCHE_COUNT] private _totalSupplies;

    /// @dev Rebalance version of `_totalSupplies`.
    uint256 private _totalSupplyVersion;

    /// @dev Amount of shares staked by each user.
    mapping(address => uint256[TRANCHE_COUNT]) private _balances;

    /// @dev Rebalance version mapping for `_balances`.
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

    uint256 private _workingSupply;
    mapping(address => uint256) private _workingBalances;
    mapping(address => VESnapshot) private _veSnapshots;

    constructor(
        address fund_,
        address chessSchedule_,
        address chessController_,
        address votingEscrow_
    ) public {
        fund = IFundV3(fund_);
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
        _votingEscrow = IVotingEscrow(votingEscrow_);
    }

    function initialize() external {
        require(_checkpointTimestamp == 0);
        _checkpointTimestamp = block.timestamp;
        _rate = IChessSchedule(chessSchedule).getRate(block.timestamp);
    }

    /// @notice Return weight of given balance with respect to rewards.
    /// @param amountQ Amount of QUEEN
    /// @param amountB Amount of BISHOP
    /// @param amountR Amount of ROOK
    /// @return Rewarding weight of the balance
    function weightedBalance(
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR
    ) public pure returns (uint256) {
        return
            amountQ.mul(REWARD_WEIGHT_Q).add(amountB.mul(REWARD_WEIGHT_B)).add(
                amountR.mul(REWARD_WEIGHT_R)
            ) / REWARD_WEIGHT_Q;
    }

    function totalSupply(uint256 tranche) external view returns (uint256) {
        uint256 totalSupplyQ = _totalSupplies[TRANCHE_Q];
        uint256 totalSupplyB = _totalSupplies[TRANCHE_B];
        uint256 totalSupplyR = _totalSupplies[TRANCHE_R];

        uint256 version = _totalSupplyVersion;
        uint256 rebalanceSize = _fundRebalanceSize();
        if (version < rebalanceSize) {
            (totalSupplyQ, totalSupplyB, totalSupplyR) = _fundBatchRebalance(
                totalSupplyQ,
                totalSupplyB,
                totalSupplyR,
                version,
                rebalanceSize
            );
        }

        if (tranche == TRANCHE_Q) {
            return totalSupplyQ;
        } else if (tranche == TRANCHE_B) {
            return totalSupplyB;
        } else {
            return totalSupplyR;
        }
    }

    function trancheBalanceOf(uint256 tranche, address account) external view returns (uint256) {
        uint256 amountQ = _balances[account][TRANCHE_Q];
        uint256 amountB = _balances[account][TRANCHE_B];
        uint256 amountR = _balances[account][TRANCHE_R];

        if (tranche == TRANCHE_Q) {
            if (amountQ == 0 && amountB == 0 && amountR == 0) return 0;
        } else if (tranche == TRANCHE_B) {
            if (amountB == 0) return 0;
        } else {
            if (amountR == 0) return 0;
        }

        uint256 version = _balanceVersions[account];
        uint256 rebalanceSize = _fundRebalanceSize();
        if (version < rebalanceSize) {
            (amountQ, amountB, amountR) = _fundBatchRebalance(
                amountQ,
                amountB,
                amountR,
                version,
                rebalanceSize
            );
        }

        if (tranche == TRANCHE_Q) {
            return amountQ;
        } else if (tranche == TRANCHE_B) {
            return amountB;
        } else {
            return amountR;
        }
    }

    function balanceVersion(address account) external view returns (uint256) {
        return _balanceVersions[account];
    }

    function workingSupply() external view returns (uint256) {
        uint256 version = _totalSupplyVersion;
        uint256 rebalanceSize = _fundRebalanceSize();
        if (version < rebalanceSize) {
            (uint256 totalSupplyQ, uint256 totalSupplyB, uint256 totalSupplyR) =
                _fundBatchRebalance(
                    _totalSupplies[TRANCHE_Q],
                    _totalSupplies[TRANCHE_B],
                    _totalSupplies[TRANCHE_R],
                    version,
                    rebalanceSize
                );
            return weightedBalance(totalSupplyQ, totalSupplyB, totalSupplyR);
        } else {
            return _workingSupply;
        }
    }

    function workingBalanceOf(address account) external view returns (uint256) {
        uint256 version = _balanceVersions[account];
        uint256 rebalanceSize = _fundRebalanceSize();
        uint256 workingBalance = _workingBalances[account]; // gas saver
        if (version < rebalanceSize || workingBalance == 0) {
            uint256[TRANCHE_COUNT] storage balance = _balances[account];
            uint256 amountQ = balance[TRANCHE_Q];
            uint256 amountB = balance[TRANCHE_B];
            uint256 amountR = balance[TRANCHE_R];
            if (version < rebalanceSize) {
                (amountQ, amountB, amountR) = _fundBatchRebalance(
                    amountQ,
                    amountB,
                    amountR,
                    version,
                    rebalanceSize
                );
            }
            return weightedBalance(amountQ, amountB, amountR);
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
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR,
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
        return fund.doRebalance(amountQ, amountB, amountR, index);
    }

    function _fundBatchRebalance(
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR,
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
        return fund.batchRebalance(amountQ, amountB, amountR, fromIndex, toIndex);
    }

    /// @dev Stake share tokens.
    /// @param tranche Tranche of the share
    /// @param amount The amount to deposit
    /// @param recipient Address that receives deposit
    /// @param version The current rebalance version
    function deposit(
        uint256 tranche,
        uint256 amount,
        address recipient,
        uint256 version
    ) public {
        _checkpoint(version);
        _userCheckpoint(recipient, version);
        _balances[recipient][tranche] = _balances[recipient][tranche].add(amount);
        _totalSupplies[tranche] = _totalSupplies[tranche].add(amount);
        _updateWorkingBalance(recipient);
        // version is checked by the fund
        fund.trancheTransferFrom(tranche, msg.sender, address(this), amount, version);
        emit Deposited(tranche, recipient, amount);
    }

    /// @notice Unstake tranche tokens.
    /// @param tranche Tranche of the share
    /// @param amount The amount to withdraw
    /// @param version The current rebalance version
    function withdraw(
        uint256 tranche,
        uint256 amount,
        uint256 version
    ) external {
        _checkpoint(version);
        _userCheckpoint(msg.sender, version);
        _balances[msg.sender][tranche] = _balances[msg.sender][tranche].sub(
            amount,
            "Insufficient balance to withdraw"
        );
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);
        _updateWorkingBalance(msg.sender);
        // version is checked by the fund
        fund.trancheTransfer(tranche, msg.sender, amount, version);
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
    function claimRewards(address account) external {
        uint256 rebalanceSize = _fundRebalanceSize();
        _checkpoint(rebalanceSize);
        _userCheckpoint(account, rebalanceSize);
        uint256 amount = _claimableRewards[account];
        _claimableRewards[account] = 0;
        chessSchedule.mint(account, amount);
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
        uint256 totalSupplyQ = _totalSupplies[TRANCHE_Q];
        uint256 totalSupplyB = _totalSupplies[TRANCHE_B];
        uint256 totalSupplyR = _totalSupplies[TRANCHE_R];
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
                (totalSupplyQ, totalSupplyB, totalSupplyR) = _fundDoRebalance(
                    totalSupplyQ,
                    totalSupplyB,
                    totalSupplyR,
                    version
                );

                version++;
                // Reset total weight boosting after the first rebalance
                weight = weightedBalance(totalSupplyQ, totalSupplyB, totalSupplyR);

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
            _totalSupplies[TRANCHE_Q] = totalSupplyQ;
            _totalSupplies[TRANCHE_B] = totalSupplyB;
            _totalSupplies[TRANCHE_R] = totalSupplyR;
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
        uint256[TRANCHE_COUNT] storage balance = _balances[account];
        uint256 weight = _workingBalances[account];
        if (weight == 0) {
            // Loading available and locked is repeated to avoid "stake too deep" error.
            weight = weightedBalance(balance[TRANCHE_Q], balance[TRANCHE_B], balance[TRANCHE_R]);
            if (weight > 0) {
                // The contract was just upgraded from an old version without boosting
                _workingBalances[account] = weight;
            }
        }
        uint256 balanceQ = balance[TRANCHE_Q];
        uint256 balanceB = balance[TRANCHE_B];
        uint256 balanceR = balance[TRANCHE_R];
        for (uint256 i = oldVersion; i < targetVersion; i++) {
            rewards = rewards.add(
                weight.multiplyDecimalPrecise(_historicalIntegrals[i].sub(userIntegral))
            );
            if (balanceQ != 0 || balanceB != 0 || balanceR != 0) {
                (balanceQ, balanceB, balanceR) = _fundDoRebalance(balanceQ, balanceB, balanceR, i);
            }
            userIntegral = 0;

            // Reset per-user weight boosting after the first rebalance
            weight = weightedBalance(balanceQ, balanceB, balanceR);
        }
        rewards = rewards.add(weight.multiplyDecimalPrecise(integral.sub(userIntegral)));
        address account_ = account; // Fix the "stack too deep" error
        _claimableRewards[account_] = rewards;
        _userIntegrals[account_] = integral;

        if (oldVersion < targetVersion) {
            balance[TRANCHE_Q] = balanceQ;
            balance[TRANCHE_B] = balanceB;
            balance[TRANCHE_R] = balanceR;
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
                _totalSupplies[TRANCHE_Q],
                _totalSupplies[TRANCHE_B],
                _totalSupplies[TRANCHE_R]
            );
        uint256[TRANCHE_COUNT] storage balance = _balances[account];
        // Assume weightedBalance(x, 0, 0) always equal to x
        uint256 weightedQ = balance[TRANCHE_Q];
        uint256 weightedBR = weightedBalance(0, balance[TRANCHE_B], balance[TRANCHE_R]);

        uint256 newWorkingBalance = weightedBR.add(weightedQ);
        uint256 veProportion = _veSnapshots[account].veProportion;
        if (veProportion > 0 && _veSnapshots[account].veLocked.unlockTime > block.timestamp) {
            uint256 boostingPower = weightedSupply.multiplyDecimal(veProportion);
            if (boostingPower <= weightedBR) {
                newWorkingBalance = newWorkingBalance.add(
                    boostingPower.multiplyDecimal(MAX_BOOSTING_FACTOR_MINUS_ONE)
                );
            } else {
                uint256 boostingPowerQ =
                    (boostingPower - weightedBR)
                        .min(boostingPower.multiplyDecimal(MAX_BOOSTING_POWER_Q))
                        .min(weightedQ);
                newWorkingBalance = newWorkingBalance.add(
                    weightedBR.add(boostingPowerQ).multiplyDecimal(MAX_BOOSTING_FACTOR_MINUS_ONE)
                );
            }
        }

        _workingSupply = _workingSupply.sub(_workingBalances[account]).add(newWorkingBalance);
        _workingBalances[account] = newWorkingBalance;
    }
}
