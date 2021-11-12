// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "./IFund.sol";

interface IManagedFund is IFund {
    function getTotalUnderlying()
        external
        view
        returns (
            uint256 hotUnderlying,
            uint256 coldUnderlying,
            uint256 totalUnderlying
        );

    function getTotalDelayedUnderlying() external returns (uint256 totalDelayedUnderlying);

    function invest(uint256 amount) external;
}
