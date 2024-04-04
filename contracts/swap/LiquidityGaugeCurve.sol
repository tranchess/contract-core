// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/IChessSchedule.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IVotingEscrow.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";

interface ICurveLiquidityGauge {
    function lp_token() external view returns (address);

    function deposit(uint256 _value, address _addr, bool _claim_rewards) external;

    function withdraw(uint256 _value, bool _claim_rewards) external;

    function set_rewards_receiver(address _receiver) external;
}

interface ICurveMinter {
    function token() external view returns (address);

    function mint(address gauge_addr) external;
}

contract LiquidityGaugeCurve is CoreUtility, ERC20, Ownable {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event ReceiverUpdated(address receiver);

    uint256 private constant MAX_ITERATIONS = 500;
    uint256 private constant MAX_BOOSTING_FACTOR = 3e18;
    uint256 private constant MAX_BOOSTING_FACTOR_MINUS_ONE = MAX_BOOSTING_FACTOR - 1e18;

    ICurveLiquidityGauge public immutable curveLiquidityGauge;
    IERC20 public immutable curveLiquidityToken;
    IChessSchedule public immutable chessSchedule;
    IChessController public immutable chessController;
    ICurveMinter private immutable _curveMinter;
    IVotingEscrow private immutable _votingEscrow;
    IERC20 private immutable _bonusToken;

    uint256 private _workingSupply;
    mapping(address => uint256) private _workingBalances;

    uint256 private _chessIntegral;
    uint256 private _chessIntegralTimestamp;
    mapping(address => uint256) private _chessUserIntegrals;
    mapping(address => uint256) private _claimableChess;

    uint256 public totalBonus;
    uint256 private _bonusIntegral;
    mapping(address => uint256) private _bonusUserIntegral;
    mapping(address => uint256) private _claimableBonus;

    /// @dev Per-gauge CHESS emission rate. The product of CHESS emission rate
    ///      and weekly percentage of the gauge
    uint256 private _rate;

    bool public allowDepositFurther;

    constructor(
        string memory name_,
        string memory symbol_,
        address curveLiquidityGauge_,
        address curveMinter_,
        address chessSchedule_,
        address chessController_,
        address votingEscrow_
    ) public ERC20(name_, symbol_) {
        curveLiquidityGauge = ICurveLiquidityGauge(curveLiquidityGauge_);
        curveLiquidityToken = IERC20(ICurveLiquidityGauge(curveLiquidityGauge_).lp_token());
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
        _curveMinter = ICurveMinter(curveMinter_);
        _bonusToken = IERC20(ICurveMinter(curveMinter_).token());
        _votingEscrow = IVotingEscrow(votingEscrow_);
        _chessIntegralTimestamp = block.timestamp;
    }

    function getRate() external view returns (uint256) {
        return _rate / 1e18;
    }

    function deposit(uint256 amount, address recipient) external {
        curveLiquidityToken.safeTransferFrom(msg.sender, address(this), amount);
        if (allowDepositFurther) {
            // Deposit and claim CRV rewards before gauge checkpoint
            curveLiquidityToken.safeApprove(address(curveLiquidityGauge), amount);
            curveLiquidityGauge.deposit(amount, address(this), true);
        }

        uint256 oldWorkingBalance = _workingBalances[recipient];
        uint256 oldWorkingSupply = _workingSupply;
        _checkpoint(recipient, oldWorkingBalance, oldWorkingSupply);

        _mint(recipient, amount);
        _updateWorkingBalance(recipient, oldWorkingBalance, oldWorkingSupply);
    }

    function withdraw(uint256 amount) external {
        uint256 lpBalance = curveLiquidityToken.balanceOf(address(this));
        if (lpBalance < amount) {
            // Withdraw and claim CRV rewards before gauge checkpoint
            curveLiquidityGauge.withdraw(amount - lpBalance, true);
        }
        curveLiquidityToken.safeTransfer(msg.sender, amount);

        uint256 oldWorkingBalance = _workingBalances[msg.sender];
        uint256 oldWorkingSupply = _workingSupply;
        _checkpoint(msg.sender, oldWorkingBalance, oldWorkingSupply);

        _burn(msg.sender, amount);
        _updateWorkingBalance(msg.sender, oldWorkingBalance, oldWorkingSupply);
    }

    function _transfer(address, address, uint256) internal override {
        revert("Transfer is not allowed");
    }

    function workingBalanceOf(address account) external view returns (uint256) {
        return _workingBalances[account];
    }

    function workingSupply() external view returns (uint256) {
        return _workingSupply;
    }

    function claimableRewards(
        address account
    ) external returns (uint256 chessAmount, uint256 bonusAmount) {
        return _checkpoint(account, _workingBalances[account], _workingSupply);
    }

    function claimRewards(address account) external {
        uint256 oldWorkingBalance = _workingBalances[account];
        uint256 oldWorkingSupply = _workingSupply;
        (uint256 chessAmount, uint256 bonusAmount) = _checkpoint(
            account,
            oldWorkingBalance,
            oldWorkingSupply
        );
        _updateWorkingBalance(account, oldWorkingBalance, oldWorkingSupply);

        if (chessAmount != 0) {
            chessSchedule.mint(account, chessAmount);
            delete _claimableChess[account];
        }
        if (bonusAmount != 0) {
            totalBonus = totalBonus.sub(bonusAmount);
            _bonusToken.safeTransfer(account, bonusAmount);
            delete _claimableBonus[account];
        }
    }

    function syncWithVotingEscrow(address account) external {
        uint256 oldWorkingBalance = _workingBalances[account];
        uint256 oldWorkingSupply = _workingSupply;
        _checkpoint(account, oldWorkingBalance, oldWorkingSupply);
        _updateWorkingBalance(account, oldWorkingBalance, oldWorkingSupply);
    }

    function depositToGauge() external onlyOwner {
        uint256 lpBalance = curveLiquidityToken.balanceOf(address(this));
        curveLiquidityToken.safeApprove(address(curveLiquidityGauge), lpBalance);
        curveLiquidityGauge.deposit(lpBalance, address(this), true);
    }

    function setDepositFurther(bool allowDepositFurther_) external onlyOwner {
        allowDepositFurther = allowDepositFurther_;
    }

    function setRewardsReceiver(address receiver) external onlyOwner {
        curveLiquidityGauge.set_rewards_receiver(receiver);
        emit ReceiverUpdated(receiver);
    }

    function _updateWorkingBalance(
        address account,
        uint256 oldWorkingBalance,
        uint256 oldWorkingSupply
    ) private {
        uint256 newWorkingBalance = balanceOf(account);
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
        uint256 weight,
        uint256 totalWeight
    ) private returns (uint256 chessAmount, uint256 bonusAmount) {
        chessAmount = _chessCheckpoint(account, weight, totalWeight);
        bonusAmount = _bonusCheckpoint(account, weight, totalWeight);
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
        _curveMinter.mint(address(curveLiquidityGauge));
        uint256 currentBonus = _bonusToken.balanceOf(address(this));
        uint256 newBonus = currentBonus.sub(totalBonus);
        uint256 integral = _bonusIntegral;
        if (totalWeight != 0 && newBonus != 0) {
            integral = integral.add(newBonus.divideDecimalPrecise(totalWeight));
            _bonusIntegral = integral;
        }
        totalBonus = currentBonus;

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
}
