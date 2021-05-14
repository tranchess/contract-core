// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "./MockToken.sol";

contract MockChess is MockToken {
    mapping(uint256 => uint256) public rates;

    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals
    ) public MockToken(name, symbol, decimals) {}

    function set(uint256 timestamp, uint256 rate) external {
        rates[timestamp] = rate;
    }

    function getRate(uint256 timestamp) external view returns (uint256) {
        return rates[timestamp];
    }
}
