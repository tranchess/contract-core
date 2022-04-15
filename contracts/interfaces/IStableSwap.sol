// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IStableSwap {
    function baseAddress() external view returns (address);

    function quoteAddress() external view returns (address);

    function allBalances() external view returns (uint256, uint256);

    function virtualPrice() external view returns (uint256);

    function getCurrentD() external view returns (uint256 D);

    function getD(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 navB
    ) external view returns (uint256 D);

    function getQuoteDeltaOut(uint256 baseDelta)
        external
        view
        returns (
            uint256 quoteDelta,
            uint256 fee,
            uint256 adminFee
        );

    function getQuoteDeltaIn(uint256 baseDelta)
        external
        view
        returns (
            uint256 quoteDelta,
            uint256 fee,
            uint256 adminFee
        );

    function getBaseDeltaOut(uint256 quoteDelta)
        external
        view
        returns (
            uint256 baseDelta,
            uint256 fee,
            uint256 adminFee
        );

    function getBaseDeltaIn(uint256 quoteDelta)
        external
        view
        returns (
            uint256 baseDelta,
            uint256 fee,
            uint256 adminFee
        );

    function calculateTokenAmount(
        uint256 baseDelta,
        uint256 quoteDelta,
        bool deposit
    ) external view returns (uint256);

    function swap(
        uint256 version,
        uint256 baseDeltaOut,
        uint256 quoteDeltaOut,
        address to,
        bytes calldata data
    ) external;

    function addLiquidity(
        uint256 version,
        address to,
        uint256 minMintAmount
    ) external;

    function removeLiquidity(
        uint256 version,
        uint256 minBaseDelta,
        uint256 minQuoteDelta,
        uint256 burnAmount
    ) external returns (uint256 baseDelta, uint256 quoteDelta);

    function removeLiquidityImbalance(
        uint256 version,
        uint256 baseDelta,
        uint256 quoteDelta,
        uint256 maxBurnAmount
    ) external returns (uint256 burnAmount);

    function removeBaseLiquidity(
        uint256 version,
        uint256 burnAmount,
        uint256 minAmount
    ) external returns (uint256);

    function removeQuoteLiquidity(
        uint256 version,
        uint256 burnAmount,
        uint256 minAmount
    ) external returns (uint256);

    event LiquidityAdded(
        address indexed account,
        uint256 baseDelta,
        uint256 quoteDelta,
        uint256 fee,
        uint256 D1,
        uint256 newTokenSupply
    );
    event LiquidityRemoved(
        address indexed account,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 fee,
        uint256 lpSupply
    );
    event LiquidityImbalanceRemoved(
        address indexed account,
        uint256 baseDelta,
        uint256 quoteDelta,
        uint256 fee,
        uint256 invariant,
        uint256 lpSupply
    );
    event LiquiditySingleRemoved(address indexed account, uint256 amount, uint256 dy);
}
