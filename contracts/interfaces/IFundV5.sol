// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "./IFundV3.sol";

interface IFundV5 is IFundV3 {
    function weightB() external view returns (uint256);

    function getEquivalentTotalR() external view returns (uint256);

    function frozen() external view returns (bool);
}
