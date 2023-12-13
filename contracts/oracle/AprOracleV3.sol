// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IAprOracle.sol";

contract AprOracleV3 is IAprOracle {
    uint256 public immutable dailyRate;

    constructor(uint256 dailyRate_) public {
        dailyRate = dailyRate_;
    }

    function capture() external override returns (uint256) {
        return dailyRate;
    }
}
