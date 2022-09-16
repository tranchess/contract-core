// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAnyswapV6ERC20 is IERC20 {
    function underlying() external view returns (address);

    function mint(address to, uint256 amount) external returns (bool);

    function burn(address from, uint256 amount) external returns (bool);
}
