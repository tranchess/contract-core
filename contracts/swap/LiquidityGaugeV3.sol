// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../interfaces/ILiquidityGauge.sol";
import "../interfaces/IChessSchedule.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IStableSwap.sol";
import "../interfaces/IVotingEscrow.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";

interface ISwapBonus {
    function bonusToken() external view returns (address);

    function getBonus() external returns (uint256);
}

contract LiquidityGaugeV3 is ILiquidityGauge, ITrancheIndexV2, CoreUtility, ERC20 {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    struct Distribution {
        uint256 amountQ;
        uint256 amountB;
        uint256 amountR;
        uint256 quoteAmount;
    }

    uint256 private constant MAX_ITERATIONS = 500;
    uint256 private constant MAX_BOOSTING_FACTOR = 3e18;
    uint256 private constant MAX_BOOSTING_FACTOR_MINUS_ONE = MAX_BOOSTING_FACTOR - 1e18;

    address public immutable stableSwap;
    IERC20 private immutable _quoteToken;
    IChessSchedule public immutable chessSchedule;
    IChessController public immutable chessController;
    IFundV3 public immutable fund;
    IVotingEscrow private immutable _votingEscrow;
    address public immutable swapBonus;
    IERC20 private immutable _bonusToken;

    uint256 private _workingSupply;
    mapping(address => uint256) private _workingBalances;

    uint256 public latestVersion;
    mapping(uint256 => Distribution) public distributions;
    mapping(uint256 => uint256) public distributionTotalSupplies;
    mapping(address => Distribution) public userDistributions;
    mapping(address => uint256) public userVersions;

    uint256 private _chessIntegral;
    uint256 private _chessIntegralTimestamp;
    mapping(address => uint256) private _chessUserIntegrals;
    mapping(address => uint256) private _claimableChess;

    uint256 private _bonusIntegral;
    mapping(address => uint256) private _bonusUserIntegral;
    mapping(address => uint256) private _claimableBonus;

    /// @dev Per-gauge CHESS emission rate. The product of CHESS emission rate
    ///      and weekly percentage of the gauge
    uint256 private _rate;

    constructor(
        string memory name_,
        string memory symbol_,
        address stableSwap_,
        address chessSchedule_,
        address chessController_,
        address fund_,
        address votingEscrow_,
        address swapBonus_
    ) public ERC20(name_, symbol_) {
        stableSwap = stableSwap_;
        _quoteToken = IERC20(IStableSwap(stableSwap_).quoteAddress());
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
        fund = IFundV3(fund_);
        _votingEscrow = IVotingEscrow(votingEscrow_);
        swapBonus = swapBonus_;
        _bonusToken = IERC20(ISwapBonus(swapBonus_).bonusToken());
        _chessIntegralTimestamp = block.timestamp;
    }

    modifier onlyStableSwap() {
        require(msg.sender == stableSwap, "Only stable swap");
        _;
    }

    function getRate() external view returns (uint256) {
        return _rate / 1e18;
    }

    function mint(address account, uint256 amount) external override onlyStableSwap {
        uint256 oldWorkingBalance = _workingBalances[account];
        uint256 oldWorkingSupply = _workingSupply;
        uint256 oldBalance = balanceOf(account);
        _checkpoint(account, oldBalance, oldWorkingBalance, oldWorkingSupply);

        _mint(account, amount);
        _updateWorkingBalance(account, oldWorkingBalance, oldWorkingSupply, oldBalance.add(amount));
    }

    function burnFrom(address account, uint256 amount) external override onlyStableSwap {
        uint256 oldWorkingBalance = _workingBalances[account];
        uint256 oldWorkingSupply = _workingSupply;
        uint256 oldBalance = balanceOf(account);
        _checkpoint(account, oldBalance, oldWorkingBalance, oldWorkingSupply);

        _burn(account, amount);
        _updateWorkingBalance(account, oldWorkingBalance, oldWorkingSupply, oldBalance.sub(amount));
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 oldWorkingBalanceFrom = _workingBalances[from];
        uint256 oldWorkingBalanceTo = _workingBalances[to];
        uint256 oldBalanceFrom = balanceOf(from);
        uint256 oldBalanceTo = balanceOf(to);
        uint256 oldWorkingSupply = _workingSupply;
        _checkpoint(from, oldBalanceFrom, oldWorkingBalanceFrom, oldWorkingSupply);
        _checkpoint(to, oldBalanceTo, oldWorkingBalanceTo, oldWorkingSupply);

        super._transfer(from, to, amount);

        _updateWorkingBalance(
            from,
            oldWorkingBalanceFrom,
            oldWorkingSupply,
            oldBalanceFrom.sub(amount)
        );
        _updateWorkingBalance(to, oldWorkingBalanceTo, oldWorkingSupply, oldBalanceTo.add(amount));
    }

    function workingBalanceOf(address account) external view override returns (uint256) {
        return _workingBalances[account];
    }

    function workingSupply() external view override returns (uint256) {
        return _workingSupply;
    }

    function claimableRewards(
        address account
    )
        external
        override
        returns (
            uint256 chessAmount,
            uint256 bonusAmount,
            uint256 amountQ,
            uint256 amountB,
            uint256 amountR,
            uint256 quoteAmount
        )
    {
        return _checkpoint(account, balanceOf(account), _workingBalances[account], _workingSupply);
    }

    function claimRewards(address account) external override {
        uint256 balance = balanceOf(account);
        uint256 oldWorkingBalance = _workingBalances[account];
        uint256 oldWorkingSupply = _workingSupply;
        (
            uint256 chessAmount,
            uint256 bonusAmount,
            uint256 amountQ,
            uint256 amountB,
            uint256 amountR,
            uint256 quoteAmount
        ) = _checkpoint(account, balance, oldWorkingBalance, oldWorkingSupply);
        _updateWorkingBalance(account, oldWorkingBalance, oldWorkingSupply, balance);

        if (chessAmount != 0) {
            chessSchedule.mint(account, chessAmount);
            delete _claimableChess[account];
        }
        if (bonusAmount != 0) {
            _bonusToken.safeTransfer(account, bonusAmount);
            delete _claimableBonus[account];
        }
        if (amountQ != 0 || amountB != 0 || amountR != 0 || quoteAmount != 0) {
            uint256 version = latestVersion;
            if (amountQ != 0) {
                fund.trancheTransfer(TRANCHE_Q, account, amountQ, version);
            }
            if (amountB != 0) {
                fund.trancheTransfer(TRANCHE_B, account, amountB, version);
            }
            if (amountR != 0) {
                fund.trancheTransfer(TRANCHE_R, account, amountR, version);
            }
            if (quoteAmount != 0) {
                _quoteToken.safeTransfer(account, quoteAmount);
            }
            delete userDistributions[account];
        }
    }

    function syncWithVotingEscrow(address account) external {
        uint256 balance = balanceOf(account);
        uint256 oldWorkingBalance = _workingBalances[account];
        uint256 oldWorkingSupply = _workingSupply;
        _checkpoint(account, balance, oldWorkingBalance, oldWorkingSupply);
        _updateWorkingBalance(account, oldWorkingBalance, oldWorkingSupply, balance);
    }

    function distribute(
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR,
        uint256 quoteAmount,
        uint256 version
    ) external override onlyStableSwap {
        // Update global state
        distributions[version].amountQ = amountQ;
        distributions[version].amountB = amountB;
        distributions[version].amountR = amountR;
        distributions[version].quoteAmount = quoteAmount;
        distributionTotalSupplies[version] = totalSupply();
        latestVersion = version;
    }

    function _updateWorkingBalance(
        address account,
        uint256 oldWorkingBalance,
        uint256 oldWorkingSupply,
        uint256 newBalance
    ) private {
        uint256 newWorkingBalance = newBalance;
        uint256 veBalance = _votingEscrow.balanceOf(account);
        if (veBalance > 0) {
            uint256 veTotalSupply = _votingEscrow.totalSupply();
            uint256 maxWorkingBalance = newWorkingBalance.multiplyDecimal(MAX_BOOSTING_FACTOR);
            uint256 boostedWorkingBalance = newWorkingBalance.add(
                totalSupply().mul(veBalance).multiplyDecimal(MAX_BOOSTING_FACTOR_MINUS_ONE).div(
                    veTotalSupply
                )
            );
            newWorkingBalance = maxWorkingBalance.min(boostedWorkingBalance);
        }
        _workingSupply = oldWorkingSupply.sub(oldWorkingBalance).add(newWorkingBalance);
        _workingBalances[account] = newWorkingBalance;
    }

    function _checkpoint(
        address account,
        uint256 balance,
        uint256 weight,
        uint256 totalWeight
    )
        private
        returns (
            uint256 chessAmount,
            uint256 bonusAmount,
            uint256 amountQ,
            uint256 amountB,
            uint256 amountR,
            uint256 quoteAmount
        )
    {
        chessAmount = _chessCheckpoint(account, weight, totalWeight);
        bonusAmount = _bonusCheckpoint(account, weight, totalWeight);
        (amountQ, amountB, amountR, quoteAmount) = _distributionCheckpoint(account, balance);
    }

    function _chessCheckpoint(
        address account,
        uint256 weight,
        uint256 totalWeight
    ) private returns (uint256 amount) {
        // Update global state
        uint256 timestamp = _chessIntegralTimestamp;
        uint256 integral = _chessIntegral;
        uint256 endWeek = _endOfWeek(timestamp);
        uint256 rate = _rate;
        if (rate == 0) {
            // CHESS emission may update in the middle of a week due to cross-chain lag.
            // We re-calculate the rate if it was zero after the last checkpoint.
            uint256 weeklySupply = chessSchedule.getWeeklySupply(timestamp);
            if (weeklySupply != 0) {
                rate = (weeklySupply / (endWeek - timestamp)).mul(
                    chessController.getFundRelativeWeight(address(this), timestamp)
                );
            }
        }
        for (uint256 i = 0; i < MAX_ITERATIONS && timestamp < block.timestamp; i++) {
            uint256 endTimestamp = endWeek.min(block.timestamp);
            if (totalWeight != 0) {
                integral = integral.add(
                    rate.mul(endTimestamp - timestamp).decimalToPreciseDecimal().div(totalWeight)
                );
            }
            if (endTimestamp == endWeek) {
                rate = chessSchedule.getRate(endWeek).mul(
                    chessController.getFundRelativeWeight(address(this), endWeek)
                );
                endWeek += 1 weeks;
            }
            timestamp = endTimestamp;
        }
        _chessIntegralTimestamp = block.timestamp;
        _chessIntegral = integral;
        _rate = rate;

        // Update per-user state
        amount = _claimableChess[account].add(
            weight.multiplyDecimalPrecise(integral.sub(_chessUserIntegrals[account]))
        );
        _claimableChess[account] = amount;
        _chessUserIntegrals[account] = integral;
    }

    function _bonusCheckpoint(
        address account,
        uint256 weight,
        uint256 totalWeight
    ) private returns (uint256 amount) {
        // Update global state
        uint256 newBonus = ISwapBonus(swapBonus).getBonus();
        uint256 integral = _bonusIntegral;
        if (totalWeight != 0 && newBonus != 0) {
            integral = integral.add(newBonus.divideDecimalPrecise(totalWeight));
            _bonusIntegral = integral;
        }

        // Update per-user state
        uint256 oldUserIntegral = _bonusUserIntegral[account];
        if (oldUserIntegral == integral) {
            return _claimableBonus[account];
        }
        amount = _claimableBonus[account].add(
            weight.multiplyDecimalPrecise(integral.sub(oldUserIntegral))
        );
        _claimableBonus[account] = amount;
        _bonusUserIntegral[account] = integral;
    }

    function _distributionCheckpoint(
        address account,
        uint256 balance
    ) private returns (uint256 amountQ, uint256 amountB, uint256 amountR, uint256 quoteAmount) {
        uint256 version = userVersions[account];
        uint256 newVersion = latestVersion;

        // Update per-user state
        Distribution storage userDist = userDistributions[account];
        amountQ = userDist.amountQ;
        amountB = userDist.amountB;
        amountR = userDist.amountR;
        quoteAmount = userDist.quoteAmount;
        if (version == newVersion) {
            return (amountQ, amountB, amountR, quoteAmount);
        }
        for (uint256 i = version; i < newVersion; i++) {
            if (amountQ != 0 || amountB != 0 || amountR != 0) {
                (amountQ, amountB, amountR) = fund.doRebalance(amountQ, amountB, amountR, i);
            }
            Distribution storage dist = distributions[i + 1];
            uint256 distTotalSupply = distributionTotalSupplies[i + 1];
            if (distTotalSupply != 0) {
                amountQ = amountQ.add(dist.amountQ.mul(balance).div(distTotalSupply));
                amountB = amountB.add(dist.amountB.mul(balance).div(distTotalSupply));
                amountR = amountR.add(dist.amountR.mul(balance).div(distTotalSupply));
                quoteAmount = quoteAmount.add(dist.quoteAmount.mul(balance).div(distTotalSupply));
            }
        }
        userDist.amountQ = amountQ;
        userDist.amountB = amountB;
        userDist.amountR = amountR;
        userDist.quoteAmount = quoteAmount;
        userVersions[account] = newVersion;
    }
}
