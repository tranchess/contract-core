// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../governance/ChessRoles.sol";

import "./IAnyswapV6ERC20.sol";

contract AnyswapChess is IAnyswapV6ERC20, ERC20, ChessRoles, Ownable {
    event LogSwapin(bytes32 indexed txhash, address indexed account, uint256 amount);
    event LogSwapout(address indexed account, address indexed bindaddr, uint256 amount);

    address public constant override underlying = address(0);

    uint256 public immutable maxTotalSupply;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxTotalSupply_
    ) public ERC20(name_, symbol_) {
        maxTotalSupply = maxTotalSupply_;
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

    function withdrawUnderlying(
        uint256 /*amount*/
    ) external override {
        revert("N/A");
    }

    function Swapin(
        bytes32 txhash,
        address account,
        uint256 amount
    ) external onlyMinter returns (bool) {
        _mint(account, amount);
        emit LogSwapin(txhash, account, amount);
        return true;
    }

    function Swapout(uint256 amount, address bindaddr) external returns (bool) {
        require(bindaddr != address(0), "AnyswapV6ERC20: address(0)");
        _burn(msg.sender, amount);
        emit LogSwapout(msg.sender, bindaddr, amount);
        return true;
    }

    function _beforeTokenTransfer(
        address from,
        address, // to
        uint256 amount
    ) internal override {
        if (from == address(0)) {
            // When minting tokens
            require(totalSupply().add(amount) <= maxTotalSupply, "Max total supply exceeded");
        }
    }
}
