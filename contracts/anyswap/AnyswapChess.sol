// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../governance/ChessRoles.sol";

import "../interfaces/IAnyswapV6ERC20.sol";

contract AnyswapChess is IAnyswapV6ERC20, ERC20, ChessRoles, Ownable {
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
