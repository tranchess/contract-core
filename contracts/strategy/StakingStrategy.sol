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

contract StakingStrategy is IStrategy, Ownable, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeERC20 for IWrappedERC20;

    uint256 private immutable _interestRate;
    address private immutable _fund;
    address private immutable _tokenUnderlying;
    address payable private immutable _staker;

    uint256 private _coldUnderlying;

    constructor(
        uint256 interestRate_,
        address fund_,
        address payable staker_
    ) public {
        _interestRate = interestRate_;
        _fund = fund_;
        _tokenUnderlying = IManagedFund(fund_).tokenUnderlying();
        _staker = staker_;
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
        _staker.transfer(requestAmount);
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

    function harvest(uint256 profit) external payable nonReentrant {
        // TODO: Split the profit
        _wrap(profit);
        IWrappedERC20(_tokenUnderlying).safeTransfer(_fund, profit);
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
        require(owner() == msg.sender || _fund == msg.sender, "Caller is not a keeper");
        _;
    }
}
