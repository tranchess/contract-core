// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IFundForStrategyV2 {
    function transferToStrategy(uint256 amount) external;

    function transferFromStrategy(uint256 amount) external;

    function reportProfit(
        uint256 profit,
        uint256 totalFee,
        uint256 strategyFee
    ) external returns (uint256 outQ);

    function reportLoss(uint256 loss) external;
}
