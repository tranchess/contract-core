// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface ILiquidityGauge is IERC20 {
    function mint(address account, uint256 amount) external;

    function burnFrom(address account, uint256 amount) external;

    function workingSupply() external view returns (uint256);

    function workingBalanceOf(address account) external view returns (uint256);

    function claimableRewards(
        address account
    )
        external
        returns (
            uint256 chessAmount,
            uint256 bonusAmount,
            uint256 amountQ,
            uint256 amountB,
            uint256 amountR,
            uint256 quoteAmount
        );

    function claimRewards(address account) external;

    function distribute(
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR,
        uint256 quoteAmount,
        uint256 version
    ) external;
}
