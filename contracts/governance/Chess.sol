// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Chess is ERC20 {
    constructor(uint256 initialSupply) public ERC20("Chess", "CHESS") {
        _mint(msg.sender, initialSupply);
    }
}
