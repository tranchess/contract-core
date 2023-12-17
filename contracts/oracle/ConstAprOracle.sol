// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/IAprOracle.sol";

contract ConstAprOracle is IAprOracle, Ownable {
    event Updated(uint256 dailyRate);

    uint256 public dailyRate;

    constructor(uint256 dailyRate_) public {
        dailyRate = dailyRate_;
        emit Updated(dailyRate_);
    }

    function update(uint256 newRate) external onlyOwner {
        dailyRate = newRate;
        emit Updated(newRate);
    }

    function capture() external override returns (uint256) {
        return dailyRate;
    }
}
