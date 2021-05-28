// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface ITwapOracle {
    function getTwap(uint256 timestamp) external view returns (uint256);
}
