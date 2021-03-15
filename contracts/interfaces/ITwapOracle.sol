// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;

interface ITwapOracle {
    enum UpdateType {PRIMARY, SECONDARY, OWNER}

    function getTwap(uint256 timestamp) external view returns (uint256);

    event Update(uint256 timestamp, uint256 price, UpdateType updateType);
}
