// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/CoreUtility.sol";

import "../interfaces/IStrategy.sol";
import "../interfaces/IManagedFund.sol";

interface IWrappedERC20 is IERC20 {
    function deposit() external payable;

    function withdraw(uint256 wad) external;
}

interface ITokenHub {
    function transferOut(
        address contractAddr,
        address recipient,
        uint256 amount,
        uint64 expireTime
    ) external payable returns (bool);
}

contract StakingStrategy is IStrategy, Ownable, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IWrappedERC20;

    address public constant BNB_ADDRESS = 0x0000000000000000000000000000000000000000;
    ITokenHub public constant TOKEN_HUB = ITokenHub(0x0000000000000000000000000000000000001004);
    uint256 public constant BRIDGE_EXPIRE_TIME = 1 hours;

    uint256 private immutable _dailyInterestRate;
    address private immutable _fund;
    address private immutable _tokenUnderlying;
    address private immutable _feeCollector;
    address payable private immutable _staker;

    uint256 private _coldUnderlying;
    uint256 public splitRatio;
    uint256 public lastHarvestTimestamp;

    event Reported(
        uint256 startTimestamp,
        uint256 endTimestamp,
        uint256 estimated,
        uint256 feeRebate,
        uint256 fundIncome
    );

    constructor(
        uint256 dailyInterestRate_,
        uint256 splitRatio_,
        address fund_,
        address payable staker_
    ) public {
        _dailyInterestRate = dailyInterestRate_;
        _fund = fund_;
        _tokenUnderlying = IManagedFund(fund_).tokenUnderlying();
        _feeCollector = IManagedFund(fund_).feeCollector();
        _staker = staker_;
        splitRatio = splitRatio_;
        lastHarvestTimestamp = IManagedFund(fund_).endOfDay(block.timestamp);
    }

    function getColdUnderlying() external view override returns (uint256 underlying) {
        return _coldUnderlying;
    }

    function getTransferAmount(uint256 requestAmount)
        external
        view
        override
        returns (uint256 transferAmount)
    {
        uint256 unwrappedBalance = address(this).balance;
        uint256 wrappedBalance = IWrappedERC20(_tokenUnderlying).balanceOf(address(this));
        if (requestAmount > unwrappedBalance + wrappedBalance) {
            transferAmount = requestAmount - unwrappedBalance + wrappedBalance;
        }
    }

    function getEstimatedInterest(uint256 startDay, uint256 endDay)
        public
        view
        returns (uint256 interest)
    {
        for (uint256 iDay = startDay; iDay < endDay; iDay += 1 days) {
            interest = IFund(_fund).historicalUnderlying(iDay).multiplyDecimal(_dailyInterestRate);
        }
    }

    function execute(uint256 requestAmount, uint256 newAmount)
        external
        override
        onlyKeeper
        nonReentrant
    {
        uint256 unwrappedBalance = address(this).balance;
        uint256 wrappedBalance = IWrappedERC20(_tokenUnderlying).balanceOf(address(this));
        require(
            requestAmount <= unwrappedBalance + wrappedBalance + newAmount,
            "not enough cold underlying"
        );
        if (newAmount > 0) {
            _coldUnderlying = _coldUnderlying.add(newAmount);
            IWrappedERC20(_tokenUnderlying).safeTransferFrom(msg.sender, address(this), newAmount);
        }
        if (requestAmount > unwrappedBalance) {
            _unwrap(requestAmount - unwrappedBalance);
        }
        require(
            TOKEN_HUB.transferOut{value: requestAmount}(
                BNB_ADDRESS,
                _staker,
                requestAmount,
                uint64(block.timestamp + BRIDGE_EXPIRE_TIME)
            ),
            "BSC bridge failed"
        );
    }

    function pullout(uint256 extraAmount) external payable onlyOwner nonReentrant {
        uint256 unwrappedBalance = address(this).balance;
        uint256 wrappedBalance = IWrappedERC20(_tokenUnderlying).balanceOf(address(this));
        uint256 returnAmount = IManagedFund(_fund).getTotalDelayedUnderlying().add(extraAmount);
        require(returnAmount <= unwrappedBalance + wrappedBalance, "not enough cold underlying");
        if (returnAmount > wrappedBalance) {
            _wrap(returnAmount - wrappedBalance);
        }
        _coldUnderlying = _coldUnderlying.sub(returnAmount);
        IWrappedERC20(_tokenUnderlying).safeTransfer(_fund, returnAmount);
    }

    receive() external payable {}

    function harvest() public payable onlyKeeper nonReentrant {
        uint256 startTimestamp = lastHarvestTimestamp;
        uint256 endTimestamp = IManagedFund(_fund).endOfDay(block.timestamp);
        uint256 estimatedInterest = getEstimatedInterest(startTimestamp, endTimestamp);
        lastHarvestTimestamp = endTimestamp;

        // Split the profit
        (uint256 feeRebate, uint256 fundIncome) = _splitProfit(msg.value);
        _wrap(feeRebate);
        IWrappedERC20(_tokenUnderlying).safeTransfer(_feeCollector, feeRebate);
        _coldUnderlying = _coldUnderlying.add(fundIncome);

        emit Reported(startTimestamp, endTimestamp, estimatedInterest, feeRebate, fundIncome);
    }

    function report(uint256 gain, uint256 loss) external onlyOwner nonReentrant {
        // For Staking Strategy, the minimal gross profit is 0
        uint256 profit = gain.sub(loss, "too much loss");

        // Split the profit
        (uint256 feeRebate, uint256 fundIncome) = _splitProfit(profit);
        uint256 wrappedBalance = IWrappedERC20(_tokenUnderlying).balanceOf(address(this));
        if (wrappedBalance < feeRebate) {
            _wrap(feeRebate - wrappedBalance);
        }
        IWrappedERC20(_tokenUnderlying).safeTransfer(_feeCollector, feeRebate);
        _coldUnderlying = _coldUnderlying.add(fundIncome);

        emit Reported(lastHarvestTimestamp, 0, 0, feeRebate, fundIncome);
    }

    function _splitProfit(uint256 profit)
        private
        view
        returns (uint256 feeRebate, uint256 fundIncome)
    {
        feeRebate = profit.multiplyDecimal(splitRatio);
        fundIncome = profit.sub(feeRebate);
    }

    /// @dev Convert BNB into WBNB
    function _wrap(uint256 amount) private {
        IWrappedERC20(_tokenUnderlying).deposit{value: amount}();
    }

    /// @dev Convert WBNB into BNB
    function _unwrap(uint256 amount) private {
        IWrappedERC20(_tokenUnderlying).withdraw(amount);
    }

    modifier onlyKeeper() {
        require(
            owner() == msg.sender || _fund == msg.sender || address(TOKEN_HUB) == msg.sender,
            "Caller is not a keeper"
        );
        _;
    }
}
