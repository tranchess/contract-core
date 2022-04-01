// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "./IFund.sol";

interface IFundV2 is IFund {
    function historicalUnderlying(uint256 timestamp) external view returns (uint256);

    function getTotalUnderlying() external view returns (uint256);

    function getStrategyUnderlying() external view returns (uint256);

    function getTotalDebt() external view returns (uint256);

    function transferToStrategy(uint256 amount) external;

    function transferFromStrategy(uint256 amount) external;

    function reportProfit(uint256 profit, uint256 performanceFee) external;

    function reportLoss(uint256 loss) external;
}
