// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

interface IAprOracle {
    function capture() external returns (uint256 dailyRate);
}
