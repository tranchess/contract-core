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
        address recipient;
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

    function buyR(InputParam memory params) external {
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
                params.staking == address(0) ? params.recipient : params.staking,
                poolKey.token0,
                poolKey.token1,
                poolKey.fee,
                msg.sender
            );
        bool zeroForOne = params.tokenQuote == poolKey.token0;

        (int256 amount0Delta, int256 amount1Delta) =
            pool.swap(
                address(this),
                zeroForOne,
                -underlyingAmount.toInt256(),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                data
            );

        if (params.staking != address(0)) {
            ShareStaking(params.staking).deposit(
                TRANCHE_R,
                params.amountR,
                params.recipient,
                params.version
            );
        }

        emit SwapRook(
            params.recipient,
            params.amountR,
            0,
            0,
            uint256(zeroForOne ? amount0Delta : amount1Delta)
        );
    }

    function sellR(InputParam memory params) external {
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
                params.recipient,
                poolKey.token0,
                poolKey.token1,
                poolKey.fee,
                msg.sender
            );
        bool zeroForOne = params.tokenQuote == poolKey.token1;

        (int256 amount0Delta, int256 amount1Delta) =
            pool.swap(
                address(this),
                zeroForOne,
                underlyingAmount.toInt256(), // Exact input
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                data
            );

        emit SwapRook(
            params.recipient,
            0,
            uint256(zeroForOne ? amount0Delta : amount1Delta),
            params.amountR,
            0
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
            // Sell BISHOP to tranchess swap for quote asset
            address[] memory path = new address[](2);
            path[0] = params.inputs.fund.tokenB();
            path[1] = params.inputs.tokenQuote;
            (uint256[] memory amounts, , ) = tranchessRouter.getAmountsOut(outB, path);
            IStableSwap tranchessSwap = tranchessRouter.getSwap(path[0], path[1]);
            params.inputs.fund.trancheTransfer(
                TRANCHE_B,
                address(tranchessSwap),
                amounts[0],
                params.inputs.version
            );
            tranchessSwap.sell(params.inputs.version, amounts[1], address(this), new bytes(0));
            // Send ROOK to recipient
            params.inputs.fund.trancheTransfer(
                TRANCHE_R,
                params.recipient,
                outB,
                params.inputs.version
            );
            // Pay back the flashloan
            require(amountToPay.sub(amounts[1]) <= params.inputs.resultBoundary, "Excessive input");
            IERC20(paymentToken).safeTransfer(msg.sender, amounts[1]);
            IERC20(paymentToken).safeTransferFrom(
                params.payer,
                msg.sender,
                amountToPay - amounts[1]
            );
        } else if (paymentToken == params.tokenUnderlying) {
            // Buy BISHOP from tranchess swap using quote asset
            address[] memory path = new address[](2);
            path[0] = params.inputs.tokenQuote;
            path[1] = params.inputs.fund.tokenB();
            (uint256[] memory amounts, , ) =
                tranchessRouter.getAmountsIn(params.inputs.amountR, path);
            IStableSwap tranchessSwap = tranchessRouter.getSwap(path[0], path[1]);
            IERC20(params.inputs.tokenQuote).safeTransfer(address(tranchessSwap), amounts[0]);
            tranchessSwap.buy(params.inputs.version, amounts[1], address(this), new bytes(0));
            // Merge BISHOP and ROOK into QUEEN
            uint256 outQ =
                IPrimaryMarketV3(params.inputs.fund.primaryMarket()).merge(
                    address(this),
                    amounts[1],
                    params.inputs.version
                );
            // Redeem or swap QUEEN for underlying
            IStableSwapCoreInternalRevertExpected swapCore =
                IStableSwapCoreInternalRevertExpected(params.inputs.queenSwapOrPrimaryMarketRouter);
            uint256 underlyingAmount = swapCore.getQuoteOut(outQ);
            params.inputs.fund.trancheTransfer(
                TRANCHE_Q,
                address(swapCore),
                outQ,
                params.inputs.version
            );
            outQ = swapCore.sell(params.inputs.version, underlyingAmount, address(this), "");
            // Pay back the flashloan
            IERC20(paymentToken).safeTransfer(msg.sender, amountToPay);
            // Send the rest of quote asset to user
            uint256 resultAmount = IERC20(params.inputs.tokenQuote).balanceOf(address(this));
            require(resultAmount >= params.inputs.resultBoundary, "Insufficient output");
            IERC20(params.inputs.tokenQuote).safeTransfer(params.recipient, resultAmount);
        }
    }
}
