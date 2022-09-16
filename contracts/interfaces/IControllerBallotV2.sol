// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IControllerBallotV2 {
    function totalSupplyAtWeek(uint256 week) external view returns (uint256);

    function sumAtWeek(address pool, uint256 week) external view returns (uint256);

    function count(uint256 week)
        external
        view
        returns (uint256[] memory sums, address[] memory funds);

    function cast(uint256[] memory weights) external;
}
