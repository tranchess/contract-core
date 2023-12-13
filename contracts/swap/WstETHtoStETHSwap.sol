// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "../utils/SafeDecimalMath.sol";
import "../interfaces/IWstETH.sol";

contract WstETHtoStETHSwap {
    using SafeERC20 for IERC20;
    using SafeDecimalMath for uint256;

    address public immutable wstETH; // Base
    address public immutable stETH; // Quote

    constructor(address wstETH_) public {
        wstETH = wstETH_;
        stETH = IWstETH(wstETH_).stETH();
    }

    function getQuoteOut(uint256 baseIn) external view returns (uint256 quoteOut) {
        quoteOut = IWstETH(wstETH).getStETHByWstETH(baseIn);
    }

    function getQuoteIn(uint256 baseOut) external view returns (uint256 quoteIn) {
        quoteIn = IWstETH(wstETH).getStETHByWstETH(baseOut);
    }

    function getBaseOut(uint256 quoteIn) external view returns (uint256 baseOut) {
        baseOut = IWstETH(wstETH).getWstETHByStETH(quoteIn);
    }

    function getBaseIn(uint256 quoteOut) external view returns (uint256 baseIn) {
        baseIn = IWstETH(wstETH).getWstETHByStETH(quoteOut);
    }

    function buy(
        uint256,
        uint256,
        address recipient,
        bytes calldata
    ) external returns (uint256 realBaseOut) {
        uint256 quoteIn = IERC20(stETH).balanceOf(address(this));
        realBaseOut = IWstETH(wstETH).wrap(quoteIn);
        IERC20(wstETH).safeTransfer(recipient, realBaseOut);
    }

    function sell(
        uint256,
        uint256,
        address recipient,
        bytes calldata
    ) external returns (uint256 realQuoteOut) {
        uint256 baseIn = IERC20(wstETH).balanceOf(address(this));
        realQuoteOut = IWstETH(wstETH).unwrap(baseIn);
        IERC20(stETH).safeTransfer(recipient, realQuoteOut);
    }

    function getOraclePrice() public view returns (uint256) {
        return IWstETH(wstETH).stEthPerToken();
    }
}
