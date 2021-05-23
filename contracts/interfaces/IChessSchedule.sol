// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IChessSchedule {
    function getRate(uint256 timestamp) external view returns (uint256);

    function mint(address account, uint256 amount) external;

    function addMinter(address account) external;
}
