// SPDX-License-Identifier: MIT
pragma experimental ABIEncoderV2;
pragma solidity ^0.6.0;

interface IAprOracle {
    function capture() external returns (uint256 dailyRate);
}
