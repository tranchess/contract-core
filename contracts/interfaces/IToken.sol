// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IToken {
    function mint(address account, uint256 amount) external returns (bool);
}
