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

    function claim(address operatorAddresses, uint256 requestNumbers) external;
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

    event PerformanceFeeUpdated(uint256 newFee);
    event ValidatorsUpdated(address[] newOperators);
    event Received(address from, uint256 amount);

    uint256 public constant PROCESS_COOLDOWN = 12 hours;
    uint256 private constant MAX_PERFORMANCE_FEE_RATE = 0.5e18;

    IStakeHub public immutable STAKE_HUB;
    address public immutable fund;
    address private immutable _tokenUnderlying;

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

    function initialize(
        uint256 performanceFeeRate_,
        address[] memory operators_
    ) external initializer {
        __Ownable_init();
        _updatePerformanceFeeRate(performanceFeeRate_);
        updateOperators(operators_);
    }

    function getPendingAmount() public view returns (uint256 pendingAmount) {
        for (uint256 i = 0; i < _operators.length; i++) {
            pendingAmount = pendingAmount.add(_credits[i].lockedBNBs(address(this), 0));
        }
    }

    function getOperators() external view returns (address[] memory) {
        return _operators;
    }

    function getCredits() external view returns (IStakeCredit[] memory) {
        return _credits;
    }

    /// @notice Process contract's strategy, which includes the following steps:
    ///         1. Claim unbond requests
    ///         2. Report profit
    ///         3. Deposit / withdraw
    ///         4. Transfer to fund
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

        // Report profit
        uint256 strategyUnderlying = IFundV3(fund).getStrategyUnderlying();
        uint256 strategyBalance = IERC20(_tokenUnderlying).balanceOf(address(this));
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

        uint256 fundBalance = IWrappedERC20(_tokenUnderlying).balanceOf(fund);
        uint256 fundDebt = IFundV3(fund).getTotalDebt();
        uint256 totalHotBalance = fundBalance.add(strategyBalance).add(address(this).balance);

        if (totalHotBalance > fundDebt) {
            uint256 amount = totalHotBalance - fundDebt;
            // Deposit only if more than min delegation amount
            if (amount >= STAKE_HUB.minDelegationBNBChange()) {
                IFundForStrategy(fund).transferToStrategy(fundBalance);
                _deposit(amount);
            }
        } else {
            // Withdraw
            uint256 pendingAmount = getPendingAmount();
            uint256 totalBalance = totalHotBalance.add(pendingAmount);
            if (totalBalance < fundDebt) {
                _withdraw(fundDebt - totalBalance);
            }
        }

        // Wrap to WBNB
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
                STAKE_HUB.undelegate(_operators[i], _credits[i].getSharesByPooledBNB(amount));
                return;
            }
            amount = amount - stakes;
            STAKE_HUB.undelegate(_operators[i], _credits[i].balanceOf(address(this)));
        }
        revert("Not enough to withdraw");
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
        emit PerformanceFeeUpdated(newRate);
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

    function _validatorExist(
        address nonemptyOperator,
        address[] memory newOperators
    ) private pure returns (bool) {
        for (uint256 i = 0; i < newOperators.length; i++) {
            if (nonemptyOperator == newOperators[i]) {
                return true;
            }
        }
        return false;
    }

    /// @dev Convert BNB into WBNB
    function _wrap(uint256 amount) private {
        IWrappedERC20(_tokenUnderlying).deposit{value: amount}();
    }

    /// @dev Convert WBNB into BNB
    function _unwrap(uint256 amount) private {
        IWrappedERC20(_tokenUnderlying).withdraw(amount);
    }
}
