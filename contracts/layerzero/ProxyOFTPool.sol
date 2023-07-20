// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./ProxyOFT.sol";

import "../governance/ChessRoles.sol";

contract ProxyOFTPool is ProxyOFT, ChessRoles {
    constructor(address _lzEndpoint, address _token) public ProxyOFT(_lzEndpoint, _token) {}

    function addMinter(address account) external onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }

    function withdrawUnderlying(uint256 amount) external onlyMinter {
        IERC20(token()).safeTransfer(msg.sender, amount);
    }
}
