// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IFundBallot {
    function count(uint256 timestamp)
        external
        view
        returns (uint256[] memory ratios, address[] memory funds);

    function syncWithVotingEscrow(address account) external;
}
