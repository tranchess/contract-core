// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IChessSchedule {
    function getWeeklySupply(uint256 timestamp) external view returns (uint256);

    function getRate(uint256 timestamp) external view returns (uint256);

    function mint(address account, uint256 amount) external;

    function addMinter(address account) external;
}
