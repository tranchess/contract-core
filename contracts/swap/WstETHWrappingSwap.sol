// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "../interfaces/IStableSwap.sol";
import "../interfaces/IWstETH.sol";
import "../utils/SafeDecimalMath.sol";

contract WstETHWrappingSwap is IStableSwap {
    using SafeERC20 for IERC20;
    using SafeDecimalMath for uint256;

    address public immutable wstETH; // Base
    address public immutable stETH; // Quote

    constructor(address wstETH_) public {
        wstETH = wstETH_;
        stETH = IWstETH(wstETH_).stETH();
    }

    function getQuoteOut(uint256 baseIn) external view override returns (uint256 quoteOut) {
        quoteOut = IWstETH(wstETH).getStETHByWstETH(baseIn);
    }

    function getQuoteIn(uint256 baseOut) external view override returns (uint256 quoteIn) {
        quoteIn = IWstETH(wstETH).getStETHByWstETH(baseOut);
    }

    function getBaseOut(uint256 quoteIn) external view override returns (uint256 baseOut) {
        baseOut = IWstETH(wstETH).getWstETHByStETH(quoteIn);
    }

    function getBaseIn(uint256 quoteOut) external view override returns (uint256 baseIn) {
        baseIn = IWstETH(wstETH).getWstETHByStETH(quoteOut);
    }

    function buy(
        uint256,
        uint256,
        address recipient,
        bytes calldata
    ) external override returns (uint256 realBaseOut) {
        uint256 quoteIn = IERC20(stETH).balanceOf(address(this));
        realBaseOut = IWstETH(wstETH).wrap(quoteIn);
        IERC20(wstETH).safeTransfer(recipient, realBaseOut);
    }

    function sell(
        uint256,
        uint256,
        address recipient,
        bytes calldata
    ) external override returns (uint256 realQuoteOut) {
        uint256 baseIn = IERC20(wstETH).balanceOf(address(this));
        realQuoteOut = IWstETH(wstETH).unwrap(baseIn);
        IERC20(stETH).safeTransfer(recipient, realQuoteOut);
    }

    function baseAddress() external view override returns (address) {
        return wstETH;
    }

    function quoteAddress() external view override returns (address) {
        return stETH;
    }

    function getOraclePrice() external view override returns (uint256) {
        return IWstETH(wstETH).stEthPerToken();
    }

    function getCurrentPrice() external view override returns (uint256) {
        return IWstETH(wstETH).stEthPerToken();
    }

    function fund() external view override returns (IFundV3) {
        revert("Not implemented");
    }

    function baseTranche() external view override returns (uint256) {
        revert("Not implemented");
    }

    function allBalances() external view override returns (uint256, uint256) {
        revert("Not implemented");
    }

    function getCurrentD() external view override returns (uint256) {
        revert("Not implemented");
    }

    function getCurrentPriceOverOracle() external view override returns (uint256) {
        revert("Not implemented");
    }

    function getPriceOverOracleIntegral() external view override returns (uint256) {
        revert("Not implemented");
    }

    function addLiquidity(uint256, address) external override returns (uint256) {
        revert("Not implemented");
    }

    function removeLiquidity(
        uint256,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256, uint256) {
        revert("Not implemented");
    }

    function removeLiquidityUnwrap(
        uint256,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256, uint256) {
        revert("Not implemented");
    }

    function removeBaseLiquidity(uint256, uint256, uint256) external override returns (uint256) {
        revert("Not implemented");
    }

    function removeQuoteLiquidity(uint256, uint256, uint256) external override returns (uint256) {
        revert("Not implemented");
    }

    function removeQuoteLiquidityUnwrap(
        uint256,
        uint256,
        uint256
    ) external override returns (uint256) {
        revert("Not implemented");
    }
}
