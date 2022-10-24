// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IWithdrawalManager {
    function getWithdrawalCredential() external view returns (bytes32);

    function transferToStrategy(uint256 amount) external;
}
