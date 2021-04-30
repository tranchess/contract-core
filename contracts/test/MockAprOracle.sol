// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../interfaces/IAprOracle.sol";

contract MockAprOracle is IAprOracle {
    uint256 interestRate;

    function setRate(uint256 rate) public {
        interestRate = rate;
    }

    function capture() public override returns (uint256 dailyRate) {
        dailyRate = interestRate;
    }
}
