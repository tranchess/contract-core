// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "./IFundV4.sol";

interface IFundV5 is IFundV4 {
    function WEIGHT_B() external view returns (uint256);
}
