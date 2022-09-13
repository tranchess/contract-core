// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../governance/ChessRoles.sol";

import "../interfaces/IAnyswapV6ERC20.sol";

contract AnyswapChessPool is IAnyswapV6ERC20, ERC20, ChessRoles, Ownable {
    using SafeERC20 for IERC20;

    address public immutable override underlying;

    constructor(
        string memory name_,
        string memory symbol_,
        address underlying_
    ) public ERC20(name_, symbol_) {
        require(underlying_ != address(0) && underlying_ != address(this));
        underlying = underlying_;
        require(decimals() == ERC20(underlying_).decimals());
    }

    function addMinter(address account) external onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }

    function mint(address to, uint256 amount) external override onlyMinter returns (bool) {
        _mint(to, amount);
        return true;
    }

    function burn(address from, uint256 amount) external override onlyMinter returns (bool) {
        _burn(from, amount);
        return true;
    }

    function deposit() external returns (uint256) {
        uint256 _amount = IERC20(underlying).balanceOf(msg.sender);
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), _amount);
        return _deposit(_amount, msg.sender);
    }

    function deposit(uint256 amount) external returns (uint256) {
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), amount);
        return _deposit(amount, msg.sender);
    }

    function deposit(uint256 amount, address to) external returns (uint256) {
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), amount);
        return _deposit(amount, to);
    }

    function depositVault(uint256 amount, address to) external onlyMinter returns (uint256) {
        return _deposit(amount, to);
    }

    function _deposit(uint256 amount, address to) internal returns (uint256) {
        _mint(to, amount);
        return amount;
    }

    function withdraw() external returns (uint256) {
        return _withdraw(msg.sender, balanceOf(msg.sender), msg.sender);
    }

    function withdraw(uint256 amount) external returns (uint256) {
        return _withdraw(msg.sender, amount, msg.sender);
    }

    function withdraw(uint256 amount, address to) external returns (uint256) {
        return _withdraw(msg.sender, amount, to);
    }

    function withdrawVault(
        address from,
        uint256 amount,
        address to
    ) external onlyMinter returns (uint256) {
        return _withdraw(from, amount, to);
    }

    function _withdraw(
        address from,
        uint256 amount,
        address to
    ) internal returns (uint256) {
        _burn(from, amount);
        IERC20(underlying).safeTransfer(to, amount);
        return amount;
    }

    function withdrawUnderlying(uint256 amount) external onlyMinter {
        IERC20(underlying).safeTransfer(msg.sender, amount);
    }
}
