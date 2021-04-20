// SPDX-License-Identifier: MIT
pragma solidity 0.6.9;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/TimelockController.sol";

contract TimeLock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors
    ) public TimelockController(minDelay, proposers, executors) {}

    function addProposer(address account) external {
        grantRole(PROPOSER_ROLE, account);
    }

    function addExecutor(address account) external {
        grantRole(EXECUTOR_ROLE, account);
    }

    function removeProposer(address account) external {
        revokeRole(PROPOSER_ROLE, account);
    }

    function removeExecutor(address account) external {
        revokeRole(EXECUTOR_ROLE, account);
    }

    function isProposer(address account) external view returns (bool) {
        return hasRole(PROPOSER_ROLE, account);
    }

    function isExecutor(address account) external view returns (bool) {
        return hasRole(EXECUTOR_ROLE, account);
    }
}
