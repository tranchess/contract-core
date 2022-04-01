// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/SafeDecimalMath.sol";

import "../interfaces/IFundV3.sol";
import "../interfaces/IWrappedERC20.sol";

interface ITokenHub {
    function getMiniRelayFee() external view returns (uint256);

    function transferOut(
        address contractAddr,
        address recipient,
        uint256 amount,
        uint64 expireTime
    ) external payable returns (bool);
}

/// @notice Strategy for delegating BNB to BSC validators and earn rewards.
///
///         BSC validator delegation and reward distribution happens on the Binance Chain (BC).
///         A staker address, which is securely managed by multi-signature, executes
///         delegation-related transactions and periodically transfer rewards back to this contract
///         on BSC.
///
///         This contract is a bridge between the fund and the staker. It performs cross-chain
///         transfers from the fund to the staker and forward transfers from the staker back to
///         the fund. It is also in charge of profit bookkeeping, which is either automatcially
///         reported by reporters using scripts or manually calibrated by the owner.
contract BscStakingStrategy is Ownable {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IWrappedERC20;

    event ReporterAdded(address reporter);
    event ReporterRemoved(address reporter);
    event StakerUpdated(address staker);
    event Received(address from, uint256 amount);

    ITokenHub private constant TOKEN_HUB = ITokenHub(0x0000000000000000000000000000000000001004);
    uint256 private constant BRIDGE_EXPIRE_TIME = 1 hours;
    uint256 private constant MAX_ESTIMATED_DAILY_PROFIT_RATE = 0.1e18;
    uint256 private constant MAX_PERFORMANCE_FEE_RATE = 0.5e18;

    IFundV3 public immutable fund;
    address private immutable _tokenUnderlying;

    /// @notice BEP2 address that does the actual staking on Binance Chain.
    ///         DO NOT transfer any asset to this address on Binance Smart Chain.
    address public staker;

    /// @notice Fraction of profit that goes to the fund's fee collector.
    uint256 public performanceFeeRate;

    /// @notice Estimated daily profit rate. This value limits the maximum daily profit that can be
    ///         reported by a reporter.
    uint256 public estimatedDailyProfitRate;

    /// @notice Amount of underlying lost since the last peak. Performance fee is charged
    ///         only when this value is zero.
    uint256 public currentDrawdown;

    /// @notice The set of reporters. Reporters can report profit within a pre-configured range
    ///         once a day.
    mapping(address => bool) public reporters;

    /// @notice The last trading day when a reporter reports daily profit.
    uint256 public reportedDay;

    constructor(
        address fund_,
        address staker_,
        uint256 performanceFeeRate_
    ) public {
        fund = IFundV3(fund_);
        _tokenUnderlying = IFundV3(fund_).tokenUnderlying();
        staker = staker_;
        performanceFeeRate = performanceFeeRate_;
        emit StakerUpdated(staker_);
    }

    modifier onlyReporter() {
        require(reporters[msg.sender], "Only reporter");
        _;
    }

    function addReporter(address reporter) external onlyOwner {
        require(!reporters[reporter]);
        reporters[reporter] = true;
        emit ReporterAdded(reporter);
    }

    function removeReporter(address reporter) external onlyOwner {
        require(reporters[reporter]);
        reporters[reporter] = false;
        emit ReporterRemoved(reporter);
    }

    /// @notice Report daily profit to the fund by a reporter.
    /// @param amount Absolute profit, which must be no greater than twice the estimation
    function accrueProfit(uint256 amount) external onlyReporter {
        uint256 total = fund.getStrategyUnderlying();
        require(
            amount / 2 <= total.multiplyDecimal(estimatedDailyProfitRate),
            "Profit out of range"
        );
        _accrueProfit(amount);
    }

    /// @notice Report daily profit according to the pre-configured rate by a reporter.
    function accrueEstimatedProfit() external onlyReporter {
        uint256 total = fund.getStrategyUnderlying();
        _accrueProfit(total.multiplyDecimal(estimatedDailyProfitRate));
    }

    function _accrueProfit(uint256 amount) private {
        uint256 currentDay = fund.currentDay();
        uint256 oldReportedDay = reportedDay;
        require(oldReportedDay < currentDay, "Already reported");
        reportedDay = oldReportedDay + 1 days;
        _reportProfit(amount);
    }

    function updateEstimatedDailyProfitRate(uint256 rate) external onlyOwner {
        require(rate < MAX_ESTIMATED_DAILY_PROFIT_RATE);
        estimatedDailyProfitRate = rate;
        reportedDay = fund.currentDay();
    }

    /// @notice Report profit to the fund by the owner.
    function reportProfit(uint256 amount) external onlyOwner {
        reportedDay = fund.currentDay();
        _reportProfit(amount);
    }

    /// @dev Report profit and performance fee to the fund. Performance fee is charged only when
    ///      there's no previous loss to cover.
    function _reportProfit(uint256 amount) private {
        uint256 oldDrawdown = currentDrawdown;
        if (amount < oldDrawdown) {
            currentDrawdown = oldDrawdown - amount;
            fund.reportProfit(amount, 0);
        } else {
            if (oldDrawdown > 0) {
                currentDrawdown = 0;
            }
            uint256 performanceFee = (amount - oldDrawdown).multiplyDecimal(performanceFeeRate);
            fund.reportProfit(amount, performanceFee);
        }
    }

    /// @notice Report loss to the fund. Performance fee will not be charged until
    ///         the current drawdown is covered.
    function reportLoss(uint256 amount) external onlyOwner {
        reportedDay = fund.currentDay();
        currentDrawdown = currentDrawdown.add(amount);
        fund.reportLoss(amount);
    }

    function updateStaker(address newStaker) external onlyOwner {
        require(newStaker != address(0));
        staker = newStaker;
        emit StakerUpdated(newStaker);
    }

    function updatePerformanceFeeRate(uint256 newRate) external onlyOwner {
        require(newRate <= MAX_PERFORMANCE_FEE_RATE);
        performanceFeeRate = newRate;
    }

    /// @notice Transfer underlying tokens from the fund to the staker on Binance Chain.
    /// @param amount Amount of underlying transfered from the fund, including cross-chain relay fee
    function transferToStaker(uint256 amount) external onlyOwner {
        fund.transferToStrategy(amount);
        _unwrap(amount);
        uint256 relayFee = TOKEN_HUB.getMiniRelayFee();
        require(
            TOKEN_HUB.transferOut{value: amount}(
                address(0),
                staker,
                amount.sub(relayFee),
                uint64(block.timestamp + BRIDGE_EXPIRE_TIME)
            ),
            "BSC bridge failed"
        );
    }

    /// @notice Transfer all underlying tokens, both wrapped and unwrapped, to the fund.
    function transferToFund() external onlyOwner {
        uint256 unwrapped = address(this).balance;
        if (unwrapped > 0) {
            _wrap(unwrapped);
        }
        uint256 amount = IWrappedERC20(_tokenUnderlying).balanceOf(address(this));
        IWrappedERC20(_tokenUnderlying).safeApprove(address(fund), amount);
        fund.transferFromStrategy(amount);
    }

    /// @notice Receive cross-chain transfer from the staker.
    receive() external payable {
        emit Received(msg.sender, msg.value);
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
