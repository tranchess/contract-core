// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IFundForStrategy {
    function transferToStrategy(uint256 amount) external;

    function transferFromStrategy(uint256 amount) external;

    function reportProfit(uint256 profit, uint256 performanceFee) external;

    function reportLoss(uint256 loss) external;
}
