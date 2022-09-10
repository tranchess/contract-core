// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "./IStableSwap.sol";

interface ISwapRouter {
    function getSwap(address baseToken, address quoteToken) external view returns (IStableSwap);

    function getAmountsOut(uint256 amount, address[] memory path)
        external
        view
        returns (
            uint256[] memory amounts,
            IStableSwap[] memory swaps,
            bool[] memory isBuy
        );

    function getAmountsIn(uint256 amount, address[] memory path)
        external
        view
        returns (
            uint256[] memory amounts,
            IStableSwap[] memory swaps,
            bool[] memory isBuy
        );

    function addLiquidity(
        address baseToken,
        address quoteToken,
        uint256 baseDelta,
        uint256 quoteDelta,
        uint256 minMintAmount,
        uint256 version,
        uint256 deadline
    ) external payable;

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 minAmountOut,
        address[] calldata path,
        address recipient,
        address staking,
        uint256[] calldata versions,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 maxAmountIn,
        address[] calldata path,
        address recipient,
        address staking,
        uint256[] calldata versions,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForTokensUnwrap(
        uint256 amountIn,
        uint256 minAmountOut,
        address[] calldata path,
        address recipient,
        uint256[] calldata versions,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapTokensForExactTokensUnwrap(
        uint256 amountOut,
        uint256 maxAmountIn,
        address[] calldata path,
        address recipient,
        uint256[] calldata versions,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
