// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/SafeCast.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";

import "./FlashSwapRouter.sol";

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
        address token0;
        address token1;
        uint24 fee;
        address payer;
    }

    address public immutable factory;

    constructor(address tranchessRouter_, address factory_)
        public
        FlashSwapRouter(tranchessRouter_)
    {
        factory = factory_;
    }

    /// @dev Following two getters are meant for an off-chain client to call with eth_call.
    function getBuyR(InputParam memory params)
        external
        returns (uint256 quoteDelta, uint256 rookDelta)
    {
        uint256 prevQuoteAmount = IERC20(params.tokenQuote).balanceOf(msg.sender);
        uint256 prevRookAmount = IERC20(params.fund.tokenR()).balanceOf(params.recipient);
        params.staking = address(0);
        buyR(params);
        uint256 quoteAmount = IERC20(params.tokenQuote).balanceOf(msg.sender);
        uint256 rookAmount = IERC20(params.fund.tokenR()).balanceOf(params.recipient);
        quoteDelta = prevQuoteAmount.sub(quoteAmount);
        rookDelta = rookAmount.sub(prevRookAmount);
    }

    function getSellR(InputParam memory params)
        external
        returns (uint256 quoteDelta, uint256 rookDelta)
    {
        uint256 prevQuoteAmount = IERC20(params.tokenQuote).balanceOf(msg.sender);
        uint256 prevRookAmount = IERC20(params.fund.tokenR()).balanceOf(params.recipient);
        buyR(params);
        uint256 quoteAmount = IERC20(params.tokenQuote).balanceOf(msg.sender);
        uint256 rookAmount = IERC20(params.fund.tokenR()).balanceOf(params.recipient);
        quoteDelta = quoteAmount.sub(prevQuoteAmount);
        rookDelta = prevRookAmount.sub(rookAmount);
    }

    function buyR(InputParam memory params) public {
        // Calculate the exact amount of QUEEN
        uint256 inQ = IPrimaryMarketV3(params.fund.primaryMarket()).getSplitForB(params.amountR);
        // Calculate the exact amount of quote asset to pay
        uint256 underlyingAmount =
            IStableSwapCoreInternalRevertExpected(params.queenSwapOrPrimaryMarketRouter).getQuoteIn(
                inQ
            );

        address tokenUnderlying = params.fund.tokenUnderlying();
        PoolAddress.PoolKey memory poolKey =
            PoolAddress.getPoolKey(tokenUnderlying, params.tokenQuote, params.externalPoolFee);
        IUniswapV3Pool pool = IUniswapV3Pool(PoolAddress.computeAddress(factory, poolKey));
        bytes memory data =
            abi.encode(
                params,
                tokenUnderlying,
                poolKey.token0,
                poolKey.token1,
                poolKey.fee,
                msg.sender
            );
        bool zeroForOne = params.tokenQuote == poolKey.token0;

        pool.swap(
            address(this),
            zeroForOne,
            -underlyingAmount.toInt256(),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            data
        );
    }

    function sellR(InputParam memory params) public {
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
        IUniswapV3Pool pool = IUniswapV3Pool(PoolAddress.computeAddress(factory, poolKey));
        bytes memory data =
            abi.encode(
                params,
                tokenUnderlying,
                poolKey.token0,
                poolKey.token1,
                poolKey.fee,
                msg.sender
            );
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
        address pool =
            PoolAddress.computeAddress(
                factory,
                PoolAddress.getPoolKey(params.token0, params.token1, params.fee)
            );
        require(msg.sender == pool);

        (address paymentToken, uint256 amountToPay, uint256 amountOut) =
            amount0Delta > 0
                ? (params.token0, uint256(amount0Delta), uint256(-amount1Delta))
                : (params.token1, uint256(amount1Delta), uint256(-amount0Delta));

        if (paymentToken == params.inputs.tokenQuote) {
            // Create or swap borrowed underlying for QUEEN
            IStableSwapCoreInternalRevertExpected swapCore =
                IStableSwapCoreInternalRevertExpected(params.inputs.queenSwapOrPrimaryMarketRouter);
            uint256 outQ = swapCore.getBaseOut(amountOut);
            IERC20(params.tokenUnderlying).safeTransfer(address(swapCore), amountOut);
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
