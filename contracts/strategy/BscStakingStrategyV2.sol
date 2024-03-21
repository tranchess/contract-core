// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../utils/SafeDecimalMath.sol";

import "../interfaces/IFundV3.sol";
import "../interfaces/IFundForStrategy.sol";
import "../interfaces/IWrappedERC20.sol";

interface IStakeHub {
    function getValidatorCreditContract(
        address operatorAddress
    ) external view returns (address creditContract);

    function minDelegationBNBChange() external view returns (uint256);

    function delegate(address operatorAddress, bool delegateVotePower) external payable;

    function undelegate(address operatorAddress, uint256 shares) external;

    function redelegate(
        address srcValidator,
        address dstValidator,
        uint256 shares,
        bool delegateVotePower
    ) external;

    function claim(address operatorAddress, uint256 requestNumber) external;
}

interface IStakeCredit is IERC20 {
    function claimableUnbondRequest(address delegator) external view returns (uint256);

    function getPooledBNB(address account) external view returns (uint256);

    function getSharesByPooledBNB(uint256 bnbAmount) external view returns (uint256);

    function lockedBNBs(address delegator, uint256 number) external view returns (uint256);
}

contract BscStakingStrategyV2 is OwnableUpgradeable {
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[32] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IWrappedERC20;

    event PerformanceFeeRateUpdated(uint256 newRate);
    event ValidatorsUpdated(address[] newOperators);
    event BufferRatioUpdated(uint256 newRatio);
    event Received(address from, uint256 amount);

    uint256 public constant PROCESS_COOLDOWN = 12 hours;
    uint256 private constant MAX_PERFORMANCE_FEE_RATE = 0.5e18;
    uint256 private constant MAX_BUFFER_RATIO = 1e18;

    IStakeHub public immutable STAKE_HUB;
    address public immutable fund;
    address private immutable _tokenUnderlying;

    uint256 public bufferRatio;
    address[] private _operators;
    IStakeCredit[] private _credits;

    /// @notice Amount of underlying lost since the last peak. Performance fee is charged
    ///         only when this value is zero.
    uint256 public currentDrawdown;

    /// @notice Fraction of profit that goes to the fund's fee collector.
    uint256 public performanceFeeRate;

    /// @notice The last process timestamp.
    uint256 public lastTimestamp;

    constructor(address STAKE_HUB_, address fund_) public {
        STAKE_HUB = IStakeHub(STAKE_HUB_);
        fund = fund_;
        _tokenUnderlying = IFundV3(fund_).tokenUnderlying();
    }

    function initialize(uint256 performanceFeeRate_) external initializer {
        __Ownable_init();
        _updatePerformanceFeeRate(performanceFeeRate_);
    }

    function getPendingAmount() public view returns (uint256 pendingAmount) {
        for (uint256 i = 0; i < _credits.length; i++) {
            pendingAmount = pendingAmount.add(_credits[i].lockedBNBs(address(this), 0));
        }
    }

    function getOperators() external view returns (address[] memory) {
        return _operators;
    }

    function getCredits() external view returns (IStakeCredit[] memory) {
        return _credits;
    }

    /// @dev Process contract's strategy, which includes the following steps:
    ///         1. Claim unbond requests
    ///         2. Report profit
    ///         3. Deposit / withdraw
    ///         4. Transfer to fund
    ///      This function will affect the creation/redemption ratio. Frontrunning this
    ///      transaction could potentially yield better creation/redemption results.
    ///      However, considering the daily earnings from BNB staking are not significant,
    ///      we believe this margin of error is acceptable.
    function process() external {
        require(lastTimestamp + PROCESS_COOLDOWN < block.timestamp, "Process not yet");
        lastTimestamp = block.timestamp;

        // Claim all claimable requests
        for (uint256 i = 0; i < _operators.length; i++) {
            uint256 requestNumber = _credits[i].claimableUnbondRequest(address(this));
            if (requestNumber > 0) {
                STAKE_HUB.claim(_operators[i], requestNumber);
            }
        }

        // Report the gain and loss
        uint256 strategyBalance = IERC20(_tokenUnderlying).balanceOf(address(this));
        _report(strategyBalance);

        // Deposit or withdraw
        uint256 fundBalance = IWrappedERC20(_tokenUnderlying).balanceOf(fund);
        uint256 fundDebt = IFundV3(fund).getTotalDebt();
        uint256 totalHotBalance = fundBalance.add(strategyBalance).add(address(this).balance);
        uint256 totalUnderlying = IFundV3(fund).getTotalUnderlying();
        uint256 bufferSize = totalUnderlying.multiplyDecimal(bufferRatio);
        if (totalHotBalance > fundDebt) {
            uint256 amount = totalHotBalance - fundDebt;
            // Deposit only if more than both min delegation amount and buffer size
            if (amount >= STAKE_HUB.minDelegationBNBChange() && amount >= bufferSize) {
                if (fundBalance > bufferSize.add(fundDebt)) {
                    IFundForStrategy(fund).transferToStrategy(fundBalance - bufferSize - fundDebt);
                }
                _deposit(amount - bufferSize);
            }
        } else {
            // Withdraw
            uint256 amount = fundDebt - totalHotBalance;
            uint256 pendingAmount = getPendingAmount();
            if (pendingAmount < amount.add(bufferSize)) {
                _withdraw(amount + bufferSize - pendingAmount);
            }
        }

        // Transfer to Fund
        _transferToFund();
    }

    /// @dev This function will affect the creation/redemption ratio. Frontrunning this
    ///      transaction could potentially yield better creation/redemption results.
    ///      However, considering the daily earnings from BNB staking are not significant,
    ///      we believe this margin of error is acceptable.
    function report() external onlyOwner {
        uint256 strategyBalance = IERC20(_tokenUnderlying).balanceOf(address(this));
        _report(strategyBalance);
    }

    function transferToFund() external onlyOwner {
        _transferToFund();
    }

    function _report(uint256 strategyBalance) private {
        uint256 strategyUnderlying = IFundV3(fund).getStrategyUnderlying();
        uint256 newStrategyUnderlying = strategyBalance.add(address(this).balance);
        for (uint256 i = 0; i < _credits.length; i++) {
            newStrategyUnderlying = newStrategyUnderlying.add(_totalBNB(_credits[i]));
        }
        if (newStrategyUnderlying > strategyUnderlying) {
            _reportProfit(newStrategyUnderlying - strategyUnderlying);
        } else if (newStrategyUnderlying < strategyUnderlying) {
            /// @dev This should never happen, but just in case
            _reportLoss(strategyUnderlying - newStrategyUnderlying);
        }
    }

    function _transferToFund() private {
        _wrap(address(this).balance);
        uint256 amount = IWrappedERC20(_tokenUnderlying).balanceOf(address(this));
        if (amount > 0) {
            IWrappedERC20(_tokenUnderlying).safeApprove(fund, amount);
            IFundForStrategy(fund).transferFromStrategy(amount);
        }
    }

    function _deposit(uint256 amount) private {
        // Find the operator with least deposits
        require(_credits.length > 0, "No stake credit");
        uint256 minStake = type(uint256).max;
        address nextOperator = address(0);
        for (uint256 i = 0; i < _operators.length; i++) {
            uint256 temp = _credits[i].getPooledBNB(address(this));
            if (temp < minStake) {
                minStake = temp;
                nextOperator = _operators[i];
            }
        }
        // Deposit to the operator
        _unwrap(IERC20(_tokenUnderlying).balanceOf(address(this)));
        STAKE_HUB.delegate{value: amount}(nextOperator, false);
    }

    function _withdraw(uint256 amount) private {
        for (uint256 i = 0; i < _operators.length; i++) {
            // Undelegate until fulfilling the user's request
            uint256 stakes = _credits[i].getPooledBNB(address(this));
            if (stakes >= amount) {
                uint256 withdrawAmount = _credits[i].getSharesByPooledBNB(amount) + 1;
                STAKE_HUB.undelegate(
                    _operators[i],
                    withdrawAmount.min(_credits[i].balanceOf(address(this)))
                );
                return;
            }
            amount = amount - stakes;
            STAKE_HUB.undelegate(_operators[i], _credits[i].balanceOf(address(this)));
        }
    }

    function _totalBNB(IStakeCredit credit) private view returns (uint256) {
        return credit.lockedBNBs(address(this), 0).add(credit.getPooledBNB(address(this)));
    }

    function redelegate(
        address srcValidator,
        address dstValidator,
        uint256 shares,
        bool delegateVotePower
    ) external onlyOwner {
        require(_validatorExist(srcValidator, _operators), "Only exist validator");
        require(_validatorExist(dstValidator, _operators), "Only exist validator");
        STAKE_HUB.redelegate(srcValidator, dstValidator, shares, delegateVotePower);
    }

    /// @dev Report profit and performance fee to the fund. Performance fee is charged only when
    ///      there's no previous loss to cover.
    function _reportProfit(uint256 amount) private {
        uint256 oldDrawdown = currentDrawdown;
        if (amount < oldDrawdown) {
            currentDrawdown = oldDrawdown - amount;
            IFundForStrategy(fund).reportProfit(amount, 0);
        } else {
            if (oldDrawdown > 0) {
                currentDrawdown = 0;
            }
            uint256 performanceFee = (amount - oldDrawdown).multiplyDecimal(performanceFeeRate);
            IFundForStrategy(fund).reportProfit(amount, performanceFee);
        }
    }

    /// @dev Report loss to the fund.
    function _reportLoss(uint256 amount) private {
        currentDrawdown = currentDrawdown.add(amount);
        IFundForStrategy(fund).reportLoss(amount);
    }

    /// @notice Receive cross-chain transfer from the staker.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    function updatePerformanceFeeRate(uint256 newRate) external onlyOwner {
        _updatePerformanceFeeRate(newRate);
    }

    function _updatePerformanceFeeRate(uint256 newRate) private {
        require(newRate <= MAX_PERFORMANCE_FEE_RATE);
        performanceFeeRate = newRate;
        emit PerformanceFeeRateUpdated(newRate);
    }

    function updateOperators(address[] memory newOperators) public onlyOwner {
        require(newOperators.length > 0);
        // Check if all non-empty operators are in the newOperators
        for (uint256 i = 0; i < _operators.length; i++) {
            uint256 amount = _totalBNB(_credits[i]);
            if (amount > 0) {
                require(
                    _validatorExist(_operators[i], newOperators),
                    "Deleting non-empty operators"
                );
            }
        }
        // Add new operators
        delete _operators;
        delete _credits;
        for (uint256 i = 0; i < newOperators.length; i++) {
            address credit = STAKE_HUB.getValidatorCreditContract(newOperators[i]);
            assert(credit != address(0));
            _operators.push(newOperators[i]);
            _credits.push(IStakeCredit(credit));
        }
        emit ValidatorsUpdated(newOperators);
    }

    function updateBufferRatio(uint256 newRatio) external onlyOwner {
        require(newRatio <= MAX_BUFFER_RATIO);
        bufferRatio = newRatio;
        emit BufferRatioUpdated(newRatio);
    }

    function _validatorExist(
        address operator,
        address[] memory newOperators
    ) private pure returns (bool) {
        for (uint256 i = 0; i < newOperators.length; i++) {
            if (operator == newOperators[i]) {
                return true;
            }
        }
        return false;
    }

    /// @dev Convert BNB into WBNB
    function _wrap(uint256 amount) private {
        if (amount == 0) return;
        IWrappedERC20(_tokenUnderlying).deposit{value: amount}();
    }

    /// @dev Convert WBNB into BNB
    function _unwrap(uint256 amount) private {
        if (amount == 0) return;
        IWrappedERC20(_tokenUnderlying).withdraw(amount);
    }

    function pause() external onlyOwner {
        lastTimestamp = type(uint256).max / 2;
    }

    function unpause() external onlyOwner {
        lastTimestamp = 0;
    }
}
