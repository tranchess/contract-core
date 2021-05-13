// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/CoreUtility.sol";

import "../interfaces/IFund.sol";
import "../interfaces/IChess.sol";
import "../interfaces/ITrancheIndex.sol";
import "../interfaces/IPrimaryMarket.sol";

interface IChessController {
    function getFundRelativeWeight(address account, uint256 timestamp)
        external
        view
        returns (uint256);
}

abstract contract Staking is ITrancheIndex, CoreUtility {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    event Deposited(uint256 tranche, address account, uint256 amount);
    event Withdrawn(uint256 tranche, address account, uint256 amount);

    uint256 private constant MAX_ITERATIONS = 500;

    uint256 private constant REWARD_WEIGHT_A = 4;
    uint256 private constant REWARD_WEIGHT_B = 2;
    uint256 private constant REWARD_WEIGHT_P = 3;

    IFund public immutable fund;
    address private immutable tokenP;
    address private immutable tokenA;
    address private immutable tokenB;

    /// @notice The CHESS token contract.
    IChess public immutable chess;

    uint256 private _rate;

    /// @notice The controller contract.
    IChessController public immutable chessController;

    /// @notice Quote asset for the exchange. Each exchange only handles one quote asset
    address public immutable quoteAssetAddress;

    /// @dev Total amount of user shares, i.e. sum of all entries in `_availableBalances` and
    ///      `_lockedBalances`. Note that these values can be smaller than the amount of
    ///      share tokens held by this contract, because shares locked in pending trades
    ///      are not inclued in total supplies or any user's balance.
    uint256[TRANCHE_COUNT] private _totalSupplies;

    /// @dev Conversion version of `_totalSupplies`.
    uint256 private _totalSupplyVersion;

    /// @dev Amount of shares that can be withdrawn or traded by each user.
    mapping(address => uint256[TRANCHE_COUNT]) private _availableBalances;

    /// @dev Amount of shares that are locked in ask orders.
    mapping(address => uint256[TRANCHE_COUNT]) private _lockedBalances;

    /// @dev Conversion version mapping for `_availableBalances`.
    mapping(address => uint256) private _balanceVersions;

    /// @dev 1e27 * ∫(rate(t) / totalWeight(t) dt) from 0 till checkpoint.
    uint256 private _invTotalWeightIntegral;

    /// @dev Final `_invTotalWeightIntegral` before each conversion.
    uint256[] private _historyIntegrals;

    /// @dev Timestamp when checkpoint() is called.
    uint256 private _checkpointTimestamp;

    /// @dev Snapshot of `_invTotalWeightIntegral` per user.
    mapping(address => uint256) private _userIntegrals;

    /// @dev Mapping of account => claimable rewards.
    mapping(address => uint256) private _claimableRewards;

    constructor(
        address fund_,
        address chess_,
        address chessController_,
        address quoteAssetAddress_
    ) public {
        fund = IFund(fund_);
        tokenP = IFund(fund_).tokenP();
        tokenA = IFund(fund_).tokenA();
        tokenB = IFund(fund_).tokenB();
        chess = IChess(chess_);
        chessController = IChessController(chessController_);
        quoteAssetAddress = quoteAssetAddress_;
        _checkpointTimestamp = block.timestamp;

        _rate = IChess(chess_).getRate(block.timestamp);
    }

    /// @notice Return weight of given balance with respect to rewards.
    /// @param amountP Amount of Share P
    /// @param amountA Amount of Share A
    /// @param amountB Amount of Share B
    /// @return Rewarding weight of the balance
    function rewardWeight(
        uint256 amountP,
        uint256 amountA,
        uint256 amountB
    ) public pure returns (uint256) {
        return
            amountP.mul(REWARD_WEIGHT_P).add(amountA.mul(REWARD_WEIGHT_A)).add(
                amountB.mul(REWARD_WEIGHT_B)
            ) / REWARD_WEIGHT_P;
    }

    function totalSupply(uint256 tranche) external view returns (uint256) {
        uint256 totalSupplyP = _totalSupplies[TRANCHE_P];
        uint256 totalSupplyA = _totalSupplies[TRANCHE_A];
        uint256 totalSupplyB = _totalSupplies[TRANCHE_B];

        uint256 version = _totalSupplyVersion;
        uint256 conversionSize = fund.getConversionSize();
        if (version < conversionSize) {
            (totalSupplyP, totalSupplyA, totalSupplyB) = fund.batchConvert(
                totalSupplyP,
                totalSupplyA,
                totalSupplyB,
                version,
                conversionSize
            );
        }

        if (tranche == TRANCHE_P) {
            return totalSupplyP;
        } else if (tranche == TRANCHE_A) {
            return totalSupplyA;
        } else {
            return totalSupplyB;
        }
    }

    function availableBalanceOf(uint256 tranche, address account) external view returns (uint256) {
        uint256 amountP = _availableBalances[account][TRANCHE_P];
        uint256 amountA = _availableBalances[account][TRANCHE_A];
        uint256 amountB = _availableBalances[account][TRANCHE_B];

        if (tranche == TRANCHE_P) {
            if (amountP == 0 && amountA == 0 && amountB == 0) return 0;
        } else if (tranche == TRANCHE_A) {
            if (amountA == 0) return 0;
        } else {
            if (amountB == 0) return 0;
        }

        uint256 version = _balanceVersions[account];
        uint256 conversionSize = fund.getConversionSize();
        if (version < conversionSize) {
            (amountP, amountA, amountB) = fund.batchConvert(
                amountP,
                amountA,
                amountB,
                version,
                conversionSize
            );
        }

        if (tranche == TRANCHE_P) {
            return amountP;
        } else if (tranche == TRANCHE_A) {
            return amountA;
        } else {
            return amountB;
        }
    }

    function lockedBalanceOf(uint256 tranche, address account) external view returns (uint256) {
        uint256 amountP = _lockedBalances[account][TRANCHE_P];
        uint256 amountA = _lockedBalances[account][TRANCHE_A];
        uint256 amountB = _lockedBalances[account][TRANCHE_B];

        if (tranche == TRANCHE_P) {
            if (amountP == 0 && amountA == 0 && amountB == 0) return 0;
        } else if (tranche == TRANCHE_A) {
            if (amountA == 0) return 0;
        } else {
            if (amountB == 0) return 0;
        }

        uint256 version = _balanceVersions[account];
        uint256 conversionSize = fund.getConversionSize();
        if (version < conversionSize) {
            (amountP, amountA, amountB) = fund.batchConvert(
                amountP,
                amountA,
                amountB,
                version,
                conversionSize
            );
        }

        if (tranche == TRANCHE_P) {
            return amountP;
        } else if (tranche == TRANCHE_A) {
            return amountA;
        } else {
            return amountB;
        }
    }

    function balanceVersion(address account) external view returns (uint256) {
        return _balanceVersions[account];
    }

    /// @dev Deposit to get rewards
    /// @param tranche Tranche of the share
    /// @param amount The amount to deposit
    function deposit(uint256 tranche, uint256 amount) external {
        _deposit(tranche, msg.sender, amount);
    }

    /// @dev Claim settled shares and deposit to get rewards
    /// @param primaryMarket The primary market to claim shares from
    function claimAndDeposit(address primaryMarket) external {
        (uint256 createdShares, ) = IPrimaryMarket(primaryMarket).claim(msg.sender);
        _deposit(TRANCHE_P, msg.sender, createdShares);
    }

    /// @dev Withdraw
    /// @param tranche Tranche of the share
    /// @param amount The amount to deposit
    function withdraw(uint256 tranche, uint256 amount) external {
        _withdraw(tranche, msg.sender, amount);
    }

    /// @notice Convert the account to latest version and accumulate rewards. It helps to eliminate
    ///         cases when someone is stuck in a too stale version
    /// @param account Account to convert
    /// @param targetVersion Index beyond the last conversion in this transformation,
    ///                      or zero for the latest version
    function refreshBalance(address account, uint256 targetVersion) external {
        uint256 conversionSize = fund.getConversionSize();
        if (targetVersion == 0) {
            targetVersion = conversionSize;
        } else {
            require(targetVersion <= conversionSize, "Target version out of bound");
        }
        _checkpoint(conversionSize);
        _userCheckpoint(account, targetVersion);
    }

    /// @notice Return claimable rewards of an account till now.
    ///
    ///         This function should be call as a "view" function off-chain to get
    ///         the return value, e.g. using `contract.claimableRewards.call(account)` in web3
    ///         or `contract.callStatic["claimableRewards"](account)` in ethers.js.
    /// @param account Address of an account
    /// @return Amount of claimable rewards
    function claimableRewards(address account) external returns (uint256) {
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        return _claimableRewards[account];
    }

    /// @notice Convert balances and claim the rewards
    /// @param account Account to claim its rewards
    function claimRewards(address account) external {
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        _claim(account);
    }

    /// @dev Deposit to get rewards
    /// @param tranche Tranche of the share
    /// @param account Target account
    /// @param amount The amount to deposit
    function _deposit(
        uint256 tranche,
        address account,
        uint256 amount
    ) private {
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        if (tranche == TRANCHE_P) {
            IERC20(tokenP).transferFrom(account, address(this), amount);
        } else if (tranche == TRANCHE_A) {
            IERC20(tokenA).transferFrom(account, address(this), amount);
        } else {
            IERC20(tokenB).transferFrom(account, address(this), amount);
        }
        _availableBalances[account][tranche] = _availableBalances[account][tranche].add(amount);
        _totalSupplies[tranche] = _totalSupplies[tranche].add(amount);

        emit Deposited(tranche, account, amount);
    }

    /// @dev Withdraw
    /// @param tranche Tranche of the share
    /// @param account Target account
    /// @param amount The amount to deposit
    function _withdraw(
        uint256 tranche,
        address account,
        uint256 amount
    ) private {
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        _availableBalances[account][tranche] = _availableBalances[account][tranche].sub(
            amount,
            "Insufficient balance to withdraw"
        );
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);
        if (tranche == TRANCHE_P) {
            IERC20(tokenP).transfer(account, amount);
        } else if (tranche == TRANCHE_A) {
            IERC20(tokenA).transfer(account, amount);
        } else {
            IERC20(tokenB).transfer(account, amount);
        }

        emit Withdrawn(tranche, account, amount);
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
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(sender, conversionSize);
        _availableBalances[sender][tranche] = _availableBalances[sender][tranche].sub(amount);
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);
    }

    function _convertAndClearTrade(
        address account,
        uint256 amountP,
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
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        if (amountVersion < conversionSize) {
            (amountP, amountA, amountB) = fund.batchConvert(
                amountP,
                amountA,
                amountB,
                amountVersion,
                conversionSize
            );
        }
        uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
        if (amountP > 0) {
            available[TRANCHE_P] = available[TRANCHE_P].add(amountP);
            _totalSupplies[TRANCHE_P] = _totalSupplies[TRANCHE_P].add(amountP);
        }
        if (amountA > 0) {
            available[TRANCHE_A] = available[TRANCHE_A].add(amountA);
            _totalSupplies[TRANCHE_A] = _totalSupplies[TRANCHE_A].add(amountA);
        }
        if (amountB > 0) {
            available[TRANCHE_B] = available[TRANCHE_B].add(amountB);
            _totalSupplies[TRANCHE_B] = _totalSupplies[TRANCHE_B].add(amountB);
        }
        return (amountP, amountA, amountB);
    }

    function _lock(
        uint256 tranche,
        address account,
        uint256 amount
    ) internal {
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        _availableBalances[account][tranche] = _availableBalances[account][tranche].sub(
            amount,
            "Insufficient balance to lock"
        );
        _lockedBalances[account][tranche] = _lockedBalances[account][tranche].add(amount);
    }

    function _convertAndUnlock(
        address account,
        uint256 amountP,
        uint256 amountA,
        uint256 amountB,
        uint256 amountVersion
    ) internal {
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        if (amountVersion < conversionSize) {
            (amountP, amountA, amountB) = fund.batchConvert(
                amountP,
                amountA,
                amountB,
                amountVersion,
                conversionSize
            );
        }
        uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
        uint256[TRANCHE_COUNT] storage locked = _lockedBalances[account];
        if (amountP > 0) {
            available[TRANCHE_P] = available[TRANCHE_P].add(amountP);
            locked[TRANCHE_P] = locked[TRANCHE_P].sub(amountP);
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
        uint256 conversionSize = fund.getConversionSize();
        _checkpoint(conversionSize);
        _userCheckpoint(account, conversionSize);
        _lockedBalances[account][tranche] = _lockedBalances[account][tranche].sub(amount);
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);
    }

    /// @dev Transfer claimable rewards to an account. Rewards since the last user checkpoint
    ///      is not included. This function should always be called after `_userCheckpoint()`,
    ///      in order for the user to get all rewards till now.
    /// @param account Address of the account
    function _claim(address account) internal {
        chess.mint(account, _claimableRewards[account]);
        _claimableRewards[account] = 0;
    }

    /// @dev Convert total supplies to the latest version and make a global reward checkpoint.
    /// @param conversionSize The number of existing conversions. It must be the same as
    ///                       `fund.getConversionSize()`.
    function _checkpoint(uint256 conversionSize) private {
        uint256 timestamp = _checkpointTimestamp;
        if (timestamp >= block.timestamp) {
            return;
        }

        uint256 integral = _invTotalWeightIntegral;
        uint256 endWeek = endOfWeek(timestamp);
        uint256 weeklyPercentage =
            chessController.getFundRelativeWeight(address(this), endWeek - 1 weeks);
        uint256 version = _totalSupplyVersion;
        uint256 conversionTimestamp;
        if (version < conversionSize) {
            conversionTimestamp = fund.getConversionTimestamp(version);
        } else {
            conversionTimestamp = type(uint256).max;
        }
        uint256 rate = _rate;
        uint256 totalSupplyP = _totalSupplies[TRANCHE_P];
        uint256 totalSupplyA = _totalSupplies[TRANCHE_A];
        uint256 totalSupplyB = _totalSupplies[TRANCHE_B];
        uint256 weight = rewardWeight(totalSupplyP, totalSupplyA, totalSupplyB);
        uint256 timestamp_ = timestamp; // avoid stack too deep

        for (uint256 i = 0; i < MAX_ITERATIONS && timestamp_ < block.timestamp; i++) {
            uint256 endTimestamp = conversionTimestamp.min(endWeek).min(block.timestamp);

            if (weight > 0) {
                integral = integral.add(
                    rate
                        .mul(endTimestamp.sub(timestamp_))
                        .multiplyDecimal(weeklyPercentage)
                        .divideDecimalRoundPrecise(weight)
                );
            }

            if (endTimestamp == conversionTimestamp) {
                _historyIntegrals.push(integral);

                integral = 0;
                (totalSupplyP, totalSupplyA, totalSupplyB) = fund.convert(
                    totalSupplyP,
                    totalSupplyA,
                    totalSupplyB,
                    version
                );

                version++;
                weight = rewardWeight(totalSupplyP, totalSupplyA, totalSupplyB);

                if (version < conversionSize) {
                    conversionTimestamp = fund.getConversionTimestamp(version);
                } else {
                    conversionTimestamp = type(uint256).max;
                }
            }
            if (endTimestamp == endWeek) {
                rate = chess.getRate(endWeek);
                weeklyPercentage = chessController.getFundRelativeWeight(address(this), endWeek);
                endWeek += 1 weeks;
            }

            timestamp_ = endTimestamp;
        }

        _checkpointTimestamp = block.timestamp;
        _invTotalWeightIntegral = integral;
        if (_rate != rate) {
            _rate = rate;
        }
        if (_totalSupplyVersion != conversionSize) {
            _totalSupplies[TRANCHE_P] = totalSupplyP;
            _totalSupplies[TRANCHE_A] = totalSupplyA;
            _totalSupplies[TRANCHE_B] = totalSupplyB;
            _totalSupplyVersion = conversionSize;
        }
    }

    /// @dev Convert a user's balance to a given version and update this user's rewards.
    ///
    ///      In most cases, the target version is the latest version and this function cumulates
    ///      rewards till now. When this function is called from `refreshBalance()`,
    ///      `targetVersion` can be an older version, in which case rewards are cumulated till
    ///      the end of that version (i.e. the end of the trading day triggering the conversion
    ///      with index `targetVersion`).
    ///
    ///      This function should always be called after `_checkpoint()` is called, so that
    ///      the global reward checkpoint is gaurenteed up to date.
    /// @param account Account to convert
    /// @param targetVersion Index beyond the last conversion in this transformation
    function _userCheckpoint(address account, uint256 targetVersion) private {
        uint256 oldVersion = _balanceVersions[account];
        if (oldVersion > targetVersion) {
            return;
        }
        uint256 userIntegral = _userIntegrals[account];
        uint256 integral = _invTotalWeightIntegral;
        if (userIntegral == integral && oldVersion == targetVersion) {
            // Return immediately when the user's rewards have already been updated to
            // the lastest checkpoint.
            //
            // Note that when `targetVersion` is not the latest version, it is possible,
            // although extremely rare, that `userIntegral` and the global `integral` are
            // in different versions but happen to equal, in which case this function returns here
            // without cumulating rewards to the end of that version.
            return;
        }

        uint256[TRANCHE_COUNT] storage available = _availableBalances[account];
        uint256[TRANCHE_COUNT] storage locked = _lockedBalances[account];
        uint256 availableP = available[TRANCHE_P];
        uint256 availableA = available[TRANCHE_A];
        uint256 availableB = available[TRANCHE_B];
        uint256 lockedP = locked[TRANCHE_P];
        uint256 lockedA = locked[TRANCHE_A];
        uint256 lockedB = locked[TRANCHE_B];
        uint256 rewards = _claimableRewards[account];
        for (uint256 i = oldVersion; i < targetVersion; i++) {
            uint256 weight =
                rewardWeight(
                    availableP.add(lockedP),
                    availableA.add(lockedA),
                    availableB.add(lockedB)
                );
            rewards = rewards.add(
                weight.multiplyDecimalRoundPrecise(_historyIntegrals[i].sub(userIntegral))
            );
            if (availableP != 0 || availableA != 0 || availableB != 0) {
                (availableP, availableA, availableB) = fund.convert(
                    availableP,
                    availableA,
                    availableB,
                    i
                );
            }
            if (lockedP != 0 || lockedA != 0 || lockedB != 0) {
                (lockedP, lockedA, lockedB) = fund.convert(lockedP, lockedA, lockedB, i);
            }
            userIntegral = 0;
        }
        uint256 weight =
            rewardWeight(availableP.add(lockedP), availableA.add(lockedA), availableB.add(lockedB));
        rewards = rewards.add(weight.multiplyDecimalRoundPrecise(integral.sub(userIntegral)));
        address account_ = account; // Fix the "stack too deep" error
        _claimableRewards[account_] = rewards;
        _userIntegrals[account_] = integral;

        if (oldVersion < targetVersion) {
            if (available[TRANCHE_P] != availableP) {
                available[TRANCHE_P] = availableP;
            }
            if (available[TRANCHE_A] != availableA) {
                available[TRANCHE_A] = availableA;
            }
            if (available[TRANCHE_B] != availableB) {
                available[TRANCHE_B] = availableB;
            }
            if (locked[TRANCHE_P] != lockedP) {
                locked[TRANCHE_P] = lockedP;
            }
            if (locked[TRANCHE_A] != lockedA) {
                locked[TRANCHE_A] = lockedA;
            }
            if (locked[TRANCHE_B] != lockedB) {
                locked[TRANCHE_B] = lockedB;
            }
            _balanceVersions[account_] = targetVersion;
        }
    }
}
