// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "./FlashSwapRouterV3.sol";

contract FlashSwapRouterV3Helper {
    FlashSwapRouterV3 public immutable flashSwapRouter;

    constructor(address flashSwapRouter_) public {
        flashSwapRouter = FlashSwapRouterV3(flashSwapRouter_);
    }

    /// @dev Only meant for an off-chain client to call with eth_call.
    ///      This function uses binary search to find the maximum `outR` in the range `[minOutR, maxOutR)`
    ///      such that `getBuyR(outR).quoteDelta <= inQuote`. When `inQuote` does not increase monotonically
    ///      with `outR`, this function does not guarantee to return the optimal solution.
    ///
    ///      Although `FlashSwapRouterV3.getBuyR` is not a view function, it typically does not alter any
    ///      contract state. However, this function fails when `FlashSwapRouterV3.getBuyR` does modify some state.
    function getBuyRFromQuote(
        IFundV5 fund,
        bool needWrap,
        address queenSwapOrPrimaryMarketRouter,
        address tokenQuote,
        uint256 minOutR,
        uint256 maxOutR,
        uint256 precision,
        uint256 inQuote
    ) external returns (uint256 outR) {
        while (minOutR + precision < maxOutR) {
            uint256 midOutR = minOutR / 2 + maxOutR / 2;
            (bool success, bytes memory data) = address(flashSwapRouter).call(
                abi.encodeWithSelector(
                    FlashSwapRouterV3.getBuyR.selector,
                    fund,
                    needWrap,
                    queenSwapOrPrimaryMarketRouter,
                    tokenQuote,
                    midOutR
                )
            );
            if (success) {
                (uint256 quoteDelta, ) = abi.decode(data, (uint256, uint256));
                if (quoteDelta <= inQuote) {
                    minOutR = midOutR;
                    continue;
                }
            }
            maxOutR = midOutR;
        }
        return minOutR;
    }
}
