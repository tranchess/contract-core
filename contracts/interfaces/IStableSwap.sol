// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IStableSwap {
    function baseAddress() external view returns (address);

    function quoteAddress() external view returns (address);

    function allBalances() external view returns (uint256, uint256);

    function virtualPrice() external view returns (uint256);

    function getCurrentD() external view returns (uint256);

    function getD(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 navB
    ) external view returns (uint256);

    function getQuoteOut(uint256 baseIn) external view returns (uint256 quoteOut);

    function getQuoteIn(uint256 baseOut) external view returns (uint256 quoteIn);

    function getBaseOut(uint256 quoteIn) external view returns (uint256 baseOut);

    function getBaseIn(uint256 quoteOut) external view returns (uint256 baseIn);

    function buy(
        uint256 version,
        uint256 baseOut,
        address recipient,
        bytes calldata data
    ) external;

    function sell(
        uint256 version,
        uint256 quoteOut,
        address recipient,
        bytes calldata data
    ) external;

    function addLiquidity(uint256 version, address recipient) external returns (uint256);

    function removeLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minBaseOut,
        uint256 minQuoteOut
    ) external returns (uint256 baseDelta, uint256 quoteDelta);

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
}
