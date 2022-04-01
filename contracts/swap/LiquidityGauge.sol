// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../interfaces/ILiquidityGauge.sol";
import "../interfaces/IChessSchedule.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/ITrancheIndex.sol";
import "../interfaces/IStableSwap.sol";
import "../interfaces/IVotingEscrow.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";

interface IController {
    function getRelativeWeight(address gauge, uint256 timestamp) external view returns (uint256);
}

interface ISwapRewards {
    function getReward() external;
}

struct Distribution {
    uint256 totalM;
    uint256 totalA;
    uint256 totalB;
    uint256 totalU;
    uint256 workingSupply;
}

contract LiquidityGauge is ILiquidityGauge, ITrancheIndex, CoreUtility, Ownable {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    uint256 private constant MAX_ITERATIONS = 500;
    uint256 private constant QUOTE_ASSET = 3;
    uint256 private constant MAX_BOOSTING_FACTOR = 3e18;
    uint256 private constant MAX_BOOSTING_FACTOR_MINUS_ONE = MAX_BOOSTING_FACTOR - 1e18;

    IChessSchedule public immutable chessSchedule;
    IChessController public immutable chessController;
    IFundV3 public immutable fund;
    IVotingEscrow public immutable votingEscrow;

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    uint256 private _workingSupply;
    mapping(address => uint256) private _workingBalances;

    uint256 public overallIntegral;
    uint256 public lastTimestamp;
    uint256 public currentRebalanceVersion;
    mapping(address => uint256) public integrals;
    mapping(address => uint256) public claimableTokens;
    mapping(address => uint256[TRANCHE_COUNT]) public claimableAssets;
    mapping(address => uint256) public distributionVersions;
    mapping(uint256 => Distribution) public distributions;

    address public rewardToken;
    address public rewardContract;
    uint256 public rewardIntegral;
    mapping(address => uint256) public rewardIntegrals;
    mapping(address => uint256) claimableRewards;

    constructor(
        string memory name_,
        string memory symbol_,
        address chessSchedule_,
        address chessController_,
        address fund_,
        address votingEscrow_
    ) public {
        name = name_;
        symbol = symbol_;
        decimals = 18;
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
        fund = IFundV3(fund_);
        votingEscrow = IVotingEscrow(votingEscrow_);
        lastTimestamp = block.timestamp;
    }

    // ------------------------------ ERC20 ------------------------------------

    function totalSupply() public view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }

    function mint(address account, uint256 amount) external override onlyOwner {
        require(account != address(0), "ERC20: mint to the zero address");
        uint256 workingSupply = _workingSupply;
        uint256 workingBalance = _workingBalances[account];
        _checkpoint(workingSupply);
        _tokenCheckpoint(account, workingBalance);
        _assetCheckpoint(account, workingBalance);

        uint256 newTotalSupply = _totalSupply.add(amount);
        uint256 newBalance = _balances[account].add(amount);
        _totalSupply = newTotalSupply;
        _balances[account] = newBalance;

        _updateWorkingBalance(account, workingBalance, workingSupply, newBalance, newTotalSupply);
    }

    function burnFrom(address account, uint256 amount) external override onlyOwner {
        require(account != address(0), "ERC20: burn from the zero address");
        uint256 workingSupply = _workingSupply;
        uint256 workingBalance = _workingBalances[account];
        _checkpoint(workingSupply);
        _tokenCheckpoint(account, workingBalance);
        _assetCheckpoint(account, workingBalance);

        uint256 newBalance = _balances[account].sub(amount, "ERC20: burn amount exceeds balance");
        uint256 newTotalSupply = _totalSupply.sub(amount);
        _balances[account] = newBalance;
        _totalSupply = newTotalSupply;

        _updateWorkingBalance(account, workingBalance, workingSupply, newBalance, newTotalSupply);
    }

    // ---------------------------- LP Token -----------------------------------

    function workingBalanceOf(address account) external view override returns (uint256) {
        return _workingBalances[account];
    }

    function claimTokenAndAssetAndReward(address account) external override {
        userCheckpoint(account);

        chessSchedule.mint(account, claimableTokens[account]);
        delete claimableTokens[account];

        IERC20(rewardToken).safeTransfer(account, claimableRewards[account]);
        delete claimableRewards[account];

        IERC20(fund.tokenM()).safeTransfer(account, claimableAssets[account][TRANCHE_M]);
        IERC20(fund.tokenA()).safeTransfer(account, claimableAssets[account][TRANCHE_A]);
        IERC20(fund.tokenB()).safeTransfer(account, claimableAssets[account][TRANCHE_B]);
        IERC20(IStableSwap(owner()).quoteAddress()).safeTransfer(
            account,
            claimableAssets[account][QUOTE_ASSET]
        );
        delete claimableAssets[account];
    }

    function userCheckpoint(address account) public override {
        uint256 workingSupply = _workingSupply;
        _checkpoint(workingSupply);
        uint256 workingBalance = _workingBalances[account];
        _tokenCheckpoint(account, workingBalance);
        _assetCheckpoint(account, workingBalance);
        _updateWorkingBalance(
            account,
            workingBalance,
            workingSupply,
            _balances[account],
            _totalSupply
        );
        _rewardCheckpoint(account);
    }

    function _checkpoint(uint256 workingSupply) private {
        uint256 timestamp_ = lastTimestamp;
        uint256 endWeek = _endOfWeek(timestamp_);
        uint256 rate = chessSchedule.getRate(endWeek.sub(1 weeks));
        uint256 relativeWeight =
            chessController.getFundRelativeWeight(address(this), endWeek.sub(1 weeks));

        // calculate overall integral till now
        if (workingSupply != 0) {
            uint256 overallIntegral_ = overallIntegral;
            for (uint256 i = 0; i < MAX_ITERATIONS && timestamp_ < block.timestamp; i++) {
                uint256 endTimestamp = endWeek.min(block.timestamp);
                if (relativeWeight > 0) {
                    overallIntegral_ = overallIntegral_.add(
                        rate
                            .mul(relativeWeight)
                            .mul(endTimestamp.sub(timestamp_))
                            .decimalToPreciseDecimal()
                            .div(workingSupply)
                    );
                }
                rate = chessSchedule.getRate(endWeek);
                relativeWeight = chessController.getFundRelativeWeight(address(this), endWeek);
                endWeek += 1 weeks;
                timestamp_ = endTimestamp;
            }
            overallIntegral = overallIntegral_;
        }

        // update global state
        lastTimestamp = block.timestamp;
    }

    function _tokenCheckpoint(address account, uint256 workingBalance) private {
        // claim governance token till now
        uint256 claimableToken =
            workingBalance.multiplyDecimalPrecise(overallIntegral.sub(integrals[account]));
        claimableTokens[account] = claimableTokens[account].add(claimableToken);

        // update per-user state
        integrals[account] = overallIntegral;
    }

    function _updateWorkingBalance(
        address account,
        uint256 oldWorkingBalance,
        uint256 oldWorkingSupply,
        uint256 newBalance,
        uint256 newTotalSupply
    ) private {
        uint256 newWorkingBalance = newBalance;
        IVotingEscrow.LockedBalance memory newLocked = votingEscrow.getLockedBalance(account);
        if (newLocked.amount > 0 && newLocked.unlockTime > block.timestamp) {
            uint256 maxWorkingBalance = newWorkingBalance.multiplyDecimal(MAX_BOOSTING_FACTOR);
            uint256 boostingPower =
                newTotalSupply.mul(votingEscrow.balanceOf(account)).div(votingEscrow.totalSupply());
            uint256 workingBalanceAfterBoosting =
                newWorkingBalance.add(boostingPower.multiplyDecimal(MAX_BOOSTING_FACTOR_MINUS_ONE));
            newWorkingBalance = maxWorkingBalance.min(workingBalanceAfterBoosting);
        }

        _workingSupply = oldWorkingSupply.sub(oldWorkingBalance).add(newWorkingBalance);
        _workingBalances[account] = newWorkingBalance;
    }

    // ----------------------------- Rewards -----------------------------------

    function _rewardCheckpoint(address account) private {
        // Update reward integrals (no gauge weights involved: easy)
        address _rewardToken = rewardToken;

        uint256 rewardDelta = IERC20(_rewardToken).balanceOf(address(this));
        ISwapRewards(rewardContract).getReward();
        rewardDelta = IERC20(_rewardToken).balanceOf(address(this)) - rewardDelta;

        uint256 totalSupply_ = _totalSupply;
        uint256 delta = totalSupply_ > 0 ? rewardDelta.divideDecimal(totalSupply_) : 0;
        uint256 newRewardIntegral = rewardIntegral + delta;
        rewardIntegral = newRewardIntegral;
        claimableRewards[account] += _balances[account].multiplyDecimal(
            newRewardIntegral - rewardIntegrals[account]
        );
        rewardIntegrals[account] = newRewardIntegral;
    }

    // ----------------------- Asset Distribution ------------------------------

    function snapshot(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 amountU,
        uint256 rebalanceVersion
    ) external override onlyOwner {
        distributions[rebalanceVersion].totalM = amountM;
        distributions[rebalanceVersion].totalA = amountA;
        distributions[rebalanceVersion].totalB = amountB;
        distributions[rebalanceVersion].totalU = amountU;
        distributions[rebalanceVersion].workingSupply = _workingSupply;
        currentRebalanceVersion = rebalanceVersion;
    }

    function _assetCheckpoint(address account, uint256 workingBalance) private {
        uint256 version = distributionVersions[account];
        uint256 rebalanceVersion = currentRebalanceVersion;
        if (rebalanceVersion == 0 || version == rebalanceVersion) {
            return;
        } else if (version == 0) {
            distributionVersions[account] = rebalanceVersion;
            return;
        }

        uint256 amountM = claimableAssets[account][TRANCHE_M];
        uint256 amountA = claimableAssets[account][TRANCHE_A];
        uint256 amountB = claimableAssets[account][TRANCHE_B];
        uint256 amountU = claimableAssets[account][QUOTE_ASSET];
        for (; version < rebalanceVersion; version++) {
            (amountM, amountA, amountB) = fund.doRebalance(amountM, amountA, amountB, version);
            Distribution memory dist = distributions[version];
            amountM = amountM.add(dist.totalM.mul(workingBalance).div(dist.workingSupply));
            amountA = amountA.add(dist.totalA.mul(workingBalance).div(dist.workingSupply));
            amountB = amountB.add(dist.totalB.mul(workingBalance).div(dist.workingSupply));
            amountU = amountU.add(dist.totalU.mul(workingBalance).div(dist.workingSupply));
        }

        claimableAssets[account][TRANCHE_M] = amountM;
        claimableAssets[account][TRANCHE_A] = amountA;
        claimableAssets[account][TRANCHE_B] = amountB;
        claimableAssets[account][QUOTE_ASSET] = amountU;
        distributionVersions[account] = rebalanceVersion;
    }
}
