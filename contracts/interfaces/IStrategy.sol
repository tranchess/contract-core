// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IStrategy {
    function getUnderlying() external view returns (uint256 underlying);
}
