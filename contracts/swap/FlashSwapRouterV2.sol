// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/SafeCast.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";

import "./FlashSwapRouter.sol";

/// @dev See IQuoterV2.sol under https://github.com/Uniswap/v3-periphery/
interface IUniswapV3QuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );

    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountOut;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory params)
        external
        returns (
            uint256 amountIn,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}

/// @title Tranchess Flash Swap Router V2
/// @notice Router for stateless execution of flash swaps against Tranchess stable swaps
contract FlashSwapRouterV2 is FlashSwapRouter, IUniswapV3SwapCallback {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    struct InputParam {
        IFundV3 fund;
        address queenSwapOrPrimaryMarketRouter;
        uint256 resultBoundary;
        address recipient;
        address tokenQuote;
        uint24 externalPoolFee;
        address staking;
        uint256 version;
        uint256 amountR;
    }

    struct SwapCallbackData {
        InputParam inputs;
        address tokenUnderlying;
        PoolAddress.PoolKey poolKey;
        address payer;
    }

    address public immutable uniswapV3Factory;
    IUniswapV3QuoterV2 public immutable uniswapV3Quoter;

    constructor(
        address tranchessRouter_,
        address uniswapV3Factory_,
        address uniswapV3Quoter_
    ) public FlashSwapRouter(tranchessRouter_) {
        uniswapV3Factory = uniswapV3Factory_;
        uniswapV3Quoter = IUniswapV3QuoterV2(uniswapV3Quoter_);
    }

    /// @dev Only meant for an off-chain client to call with eth_call.
    ///      Note that `params.resultBoundary` is ignored.
    function getBuyRV2(InputParam memory params)
        external
        returns (uint256 quoteDelta, uint256 rookDelta)
    {
        // Calculate the exact amount of QUEEN
        uint256 inQ = IPrimaryMarketV3(params.fund.primaryMarket()).getSplitForB(params.amountR);
        // Calculate the exact amount of underlying asset
        uint256 underlyingAmount =
            IStableSwapCoreInternalRevertExpected(params.queenSwapOrPrimaryMarketRouter).getQuoteIn(
                inQ
            );
        // Calculate the exact amount of quote asset to pay
        (uint256 amountToPay, , , ) =
            uniswapV3Quoter.quoteExactOutputSingle(
                IUniswapV3QuoterV2.QuoteExactOutputSingleParams({
                    tokenIn: params.tokenQuote,
                    tokenOut: params.fund.tokenUnderlying(),
                    amountOut: underlyingAmount,
                    fee: params.externalPoolFee,
                    sqrtPriceLimitX96: 0
                })
            );
        // Calculate the QUEEN creation amount from underlying
        IStableSwapCoreInternalRevertExpected swapCore =
            IStableSwapCoreInternalRevertExpected(params.queenSwapOrPrimaryMarketRouter);
        uint256 outQ = swapCore.getBaseOut(underlyingAmount);
        // Get the amount of BISHOP and ROOK in split
        rookDelta = IPrimaryMarketV3(params.fund.primaryMarket()).getSplit(outQ);
        // Calculate the amount of quote from BISHOP sale
        IStableSwap tranchessPair =
            tranchessRouter.getSwap(params.fund.tokenB(), params.tokenQuote);
        uint256 quoteAmount = tranchessPair.getQuoteOut(rookDelta);
        // Subtract the amount of quote asset fulfilled by BISHOP sale
        quoteDelta = amountToPay.sub(quoteAmount);
    }

    /// @dev Only meant for an off-chain client to call with eth_call.
    ///      Note that `params.resultBoundary` is ignored.
    function getSellRV2(InputParam memory params)
        external
        returns (uint256 quoteDelta, uint256 rookDelta)
    {
        rookDelta = params.amountR;
        // Calculate the exact amount of QUEEN
        (uint256 outQ, ) = IPrimaryMarketV3(params.fund.primaryMarket()).getMerge(params.amountR);
        // Calculate the exact amount of underlying asset to pay
        uint256 underlyingAmount =
            IStableSwapCoreInternalRevertExpected(params.queenSwapOrPrimaryMarketRouter)
                .getQuoteOut(outQ);
        // Calculate the exact amount of quote asset to pay
        (uint256 amountToSend, , , ) =
            uniswapV3Quoter.quoteExactInputSingle(
                IUniswapV3QuoterV2.QuoteExactInputSingleParams({
                    tokenIn: params.fund.tokenUnderlying(),
                    tokenOut: params.tokenQuote,
                    amountIn: underlyingAmount,
                    fee: params.externalPoolFee,
                    sqrtPriceLimitX96: 0
                })
            );
        // Calculate the amount of quote needed for BISHOP
        IStableSwap tranchessPair =
            tranchessRouter.getSwap(params.fund.tokenB(), params.tokenQuote);
        uint256 quoteAmount = tranchessPair.getQuoteIn(params.amountR);
        // Subtract the amount of quote asset used to buy BISHOP
        quoteDelta = amountToSend.sub(quoteAmount);
    }

    function buyRV2(InputParam memory params) external {
        // Calculate the exact amount of QUEEN
        uint256 inQ = IPrimaryMarketV3(params.fund.primaryMarket()).getSplitForB(params.amountR);
        // Calculate the exact amount of underlying asset
        uint256 underlyingAmount =
            IStableSwapCoreInternalRevertExpected(params.queenSwapOrPrimaryMarketRouter).getQuoteIn(
                inQ
            );

        address tokenUnderlying = params.fund.tokenUnderlying();
        PoolAddress.PoolKey memory poolKey =
            PoolAddress.getPoolKey(tokenUnderlying, params.tokenQuote, params.externalPoolFee);
        IUniswapV3Pool pool = IUniswapV3Pool(PoolAddress.computeAddress(uniswapV3Factory, poolKey));
        bytes memory data = abi.encode(params, tokenUnderlying, poolKey, msg.sender);
        bool zeroForOne = params.tokenQuote == poolKey.token0;

        pool.swap(
            params.queenSwapOrPrimaryMarketRouter,
            zeroForOne,
            -underlyingAmount.toInt256(),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            data
        );
    }

    function sellRV2(InputParam memory params) external {
        // Transfer user's ROOK to this router
        params.fund.trancheTransferFrom(
            TRANCHE_R,
            msg.sender,
            address(this),
            params.amountR,
            params.version
        );

        // Calculate the exact amount of QUEEN
        (uint256 outQ, ) = IPrimaryMarketV3(params.fund.primaryMarket()).getMerge(params.amountR);
        // Calculate the exact amount of underlying asset to pay
        uint256 underlyingAmount =
            IStableSwapCoreInternalRevertExpected(params.queenSwapOrPrimaryMarketRouter)
                .getQuoteOut(outQ);

        address tokenUnderlying = params.fund.tokenUnderlying();
        PoolAddress.PoolKey memory poolKey =
            PoolAddress.getPoolKey(tokenUnderlying, params.tokenQuote, params.externalPoolFee);
        IUniswapV3Pool pool = IUniswapV3Pool(PoolAddress.computeAddress(uniswapV3Factory, poolKey));
        bytes memory data = abi.encode(params, tokenUnderlying, poolKey, msg.sender);
        bool zeroForOne = params.tokenQuote == poolKey.token1;

        pool.swap(
            address(this),
            zeroForOne,
            underlyingAmount.toInt256(), // Exact input
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            data
        );
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        require(amount0Delta > 0 || amount1Delta > 0); // swaps entirely within 0-liquidity regions are not supported

        SwapCallbackData memory params = abi.decode(data, (SwapCallbackData));

        // Ensure that the pool is the one we expect
        address pool = PoolAddress.computeAddress(uniswapV3Factory, params.poolKey);
        require(msg.sender == pool);

        (address paymentToken, uint256 amountToPay, uint256 amountOut) =
            amount0Delta > 0
                ? (params.poolKey.token0, uint256(amount0Delta), uint256(-amount1Delta))
                : (params.poolKey.token1, uint256(amount1Delta), uint256(-amount0Delta));

        if (paymentToken == params.inputs.tokenQuote) {
            // Create or swap borrowed underlying for QUEEN
            IStableSwapCoreInternalRevertExpected swapCore =
                IStableSwapCoreInternalRevertExpected(params.inputs.queenSwapOrPrimaryMarketRouter);
            uint256 outQ = swapCore.getBaseOut(amountOut);
            outQ = swapCore.buy(params.inputs.version, outQ, address(this), "");
            // Split QUEEN into BISHOP and ROOK
            uint256 outB =
                IPrimaryMarketV3(params.inputs.fund.primaryMarket()).split(
                    address(this),
                    outQ,
                    params.inputs.version
                );
            // Arrange the stable swap path
            IStableSwap tranchessPair =
                tranchessRouter.getSwap(params.inputs.fund.tokenB(), params.inputs.tokenQuote);
            // Sell BISHOP to tranchess swap for quote asset
            uint256 quoteAmount = tranchessPair.getQuoteOut(outB);
            // Calculate the amount of quote asset for selling BISHOP, paying back part of the flashloan
            params.inputs.fund.trancheTransfer(
                TRANCHE_B,
                address(tranchessPair),
                outB,
                params.inputs.version
            );
            tranchessPair.sell(params.inputs.version, quoteAmount, msg.sender, "");
            // Send ROOK to recipient
            params.inputs.fund.trancheTransfer(
                TRANCHE_R,
                params.inputs.staking == address(0)
                    ? params.inputs.recipient
                    : params.inputs.staking,
                outB,
                params.inputs.version
            );
            if (params.inputs.staking != address(0)) {
                ShareStaking(params.inputs.staking).deposit(
                    TRANCHE_R,
                    outB,
                    params.inputs.recipient,
                    params.inputs.version
                );
            }
            // Pay back rest of the flashloan out of user pocket
            require(
                amountToPay.sub(quoteAmount) <= params.inputs.resultBoundary,
                "Excessive input"
            );
            IERC20(paymentToken).safeTransferFrom(
                params.payer,
                msg.sender,
                amountToPay - quoteAmount
            );
            emit SwapRook(params.inputs.recipient, 0, amountToPay - quoteAmount, outB, 0);
        } else if (paymentToken == params.tokenUnderlying) {
            // Arrange the stable swap path
            IStableSwap tranchessPair =
                tranchessRouter.getSwap(params.inputs.fund.tokenB(), params.inputs.tokenQuote);
            // Buy BISHOP from tranchess swap using quote asset
            uint256 quoteAmount = tranchessPair.getQuoteIn(params.inputs.amountR);
            IERC20(params.inputs.tokenQuote).safeTransfer(address(tranchessPair), quoteAmount);
            tranchessPair.buy(params.inputs.version, params.inputs.amountR, address(this), "");
            // Merge BISHOP and ROOK into QUEEN
            IStableSwapCoreInternalRevertExpected swapCore =
                IStableSwapCoreInternalRevertExpected(params.inputs.queenSwapOrPrimaryMarketRouter);
            uint256 outQ =
                IPrimaryMarketV3(params.inputs.fund.primaryMarket()).merge(
                    address(swapCore),
                    params.inputs.amountR,
                    params.inputs.version
                );
            // Redeem or swap QUEEN for underlying, paying back the flashloan
            uint256 underlyingAmount = swapCore.getQuoteOut(outQ);
            swapCore.sell(params.inputs.version, underlyingAmount, msg.sender, "");
            // Send the rest of quote asset to user
            require(
                amountOut.sub(quoteAmount) >= params.inputs.resultBoundary,
                "Insufficient output"
            );
            IERC20(params.inputs.tokenQuote).safeTransfer(
                params.inputs.recipient,
                amountOut - quoteAmount
            );
            emit SwapRook(
                params.inputs.recipient,
                params.inputs.amountR,
                0,
                0,
                amountOut - quoteAmount
            );
        }
    }
}
