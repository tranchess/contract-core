// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IControllerBallotV2 {
    function totalSupplyAtTimestamp(uint256 timestamp) external view returns (uint256);

    function sumAtTimestamp(address pool, uint256 timestamp) external view returns (uint256);

    function count(uint256 timestamp)
        external
        view
        returns (uint256[] memory sums, address[] memory funds);

    function cast(uint256[] memory weights) external;
}
