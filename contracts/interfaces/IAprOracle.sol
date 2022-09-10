// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IAprOracle {
    function capture() external returns (uint256 dailyRate);
}
