// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IAprOracle {
    function capture() external returns (uint256 dailyRate);
}
