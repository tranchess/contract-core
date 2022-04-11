// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface ILiquidityGauge {
    // ------------------------------ ERC20 ------------------------------------

    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function mint(address account, uint256 amount) external;

    function burnFrom(address account, uint256 amount) external;

    function workingSupply() external view returns (uint256);

    function workingBalanceOf(address account) external view returns (uint256);

    // ---------------------------- LP Token -----------------------------------

    function claimableTokenAndAssetAndReward(address account)
        external
        returns (
            uint256 amountToken,
            uint256 amountReward,
            uint256 amountQ,
            uint256 amountB,
            uint256 amountR,
            uint256 amountU
        );

    function claimTokenAndAssetAndReward(address account) external;

    function userCheckpoint(address account) external;

    // ----------------------- Asset Distribution ------------------------------

    function snapshot(
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR,
        uint256 amountU,
        uint256 rebalanceVersion
    ) external;
}
