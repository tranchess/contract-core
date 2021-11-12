// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IStrategy {
    function getColdUnderlying() external view returns (uint256 underlying);

    function getTransferAmount(uint256 requestAmount)
        external
        view
        returns (uint256 transferAmount);

    function execute(uint256 requestAmount, uint256 newAmount) external;
}
