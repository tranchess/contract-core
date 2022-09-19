// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "./IFundV3.sol";

interface IFundV4 is IFundV3 {
    function getRelativeIncome(uint256 day)
        external
        view
        returns (uint256 incomeOverQ, uint256 incomeOverB);
}
