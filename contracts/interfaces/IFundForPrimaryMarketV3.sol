// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IFundForPrimaryMarketV3 {
    function primaryMarketMint(
        uint256 tranche,
        address account,
        uint256 amount,
        uint256 version
    ) external;

    function primaryMarketBurn(
        uint256 tranche,
        address account,
        uint256 amount,
        uint256 version
    ) external;

    function primaryMarketTransferUnderlying(
        address recipient,
        uint256 amount,
        uint256 fee
    ) external;

    function primaryMarketAddDebt(uint256 amount, uint256 fee) external;

    function primaryMarketPayDebt(uint256 amount) external;
}
