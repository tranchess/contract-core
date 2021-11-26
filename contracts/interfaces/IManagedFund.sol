// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "./IFund.sol";

interface IManagedFund is IFund {
    function getTotalUnderlying() external view returns (uint256);

    function getTotalDebt() external view returns (uint256);

    function invest(uint256 amount) external;

    function payDebt() external;

    function updateStrategyUnderlying(uint256 amount) external;
}
