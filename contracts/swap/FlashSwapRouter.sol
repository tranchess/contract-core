// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router01.sol";

import "../interfaces/ITranchessSwapCallee.sol";
import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/ITrancheIndexV2.sol";

/// @title Tranchess Flash Swap Router
/// @notice Router for stateless execution of flash swaps against Tranchess stable swaps
contract FlashSwapRouter is ITranchessSwapCallee, ITrancheIndexV2, Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    event SwapToggled(address externalRouter, bool enabled);

    ISwapRouter public immutable tranchessRouter;
    mapping(address => bool) public externalRouterAllowlist;

    constructor(address tranchessRouter_) public {
        tranchessRouter = ISwapRouter(tranchessRouter_);
    }

    function toggleExternalRouter(address externalRouter) external onlyOwner {
        bool enabled = !externalRouterAllowlist[externalRouter];
        externalRouterAllowlist[externalRouter] = enabled;
        emit SwapToggled(externalRouter, enabled);
    }

    function buyR(
        address primaryMarket,
        address queenSwapOrPrimaryMarketRouter,
        uint256 maxQuote,
        address recipient,
        address tokenQuote,
        address externalRouter,
        address[] memory externalPath,
        uint256 version,
        uint256 outR
    ) external {
        require(externalRouterAllowlist[externalRouter], "Invalid external router");
        IPrimaryMarketV3 pm = IPrimaryMarketV3(primaryMarket);
        uint256 underlyingAmount;
        uint256 totalQuoteAmount;
        uint256 quoteAmount;
        {
            uint256 inQ = pm.getSplitForB(outR);
            underlyingAmount = IStableSwapCore(queenSwapOrPrimaryMarketRouter).getQuoteIn(inQ);
            // Calculate the exact amount of quote asset to pay
            totalQuoteAmount = IUniswapV2Router01(externalRouter).getAmountsIn(
                underlyingAmount,
                externalPath
            )[0];
        }
        // Arrange the stable swap path
        IStableSwap tranchessPair = tranchessRouter.getSwap(pm.fund().tokenB(), tokenQuote);
        // Calculate the amount of quote asset for selling BISHOP
        quoteAmount = tranchessPair.getQuoteOut(outR);
        // Send the user's portion of the payment to Tranchess swap
        uint256 resultAmount = totalQuoteAmount.sub(quoteAmount);
        require(resultAmount <= maxQuote, "Insufficient input");
        bytes memory data =
            abi.encode(
                primaryMarket,
                queenSwapOrPrimaryMarketRouter,
                underlyingAmount,
                recipient,
                version,
                externalRouter,
                externalPath
            );
        IERC20(tokenQuote).safeTransferFrom(msg.sender, address(this), resultAmount);
        tranchessPair.sell(version, quoteAmount, address(this), data);
    }

    function sellR(
        address primaryMarket,
        address queenSwapOrPrimaryMarketRouter,
        uint256 minQuote,
        address recipient,
        address tokenQuote,
        address externalRouter,
        address[] memory externalPath,
        uint256 version,
        uint256 inR
    ) external {
        require(externalRouterAllowlist[externalRouter], "Invalid external router");
        IPrimaryMarketV3 pm = IPrimaryMarketV3(primaryMarket);
        // Send the user's ROOK to this router
        pm.fund().trancheTransferFrom(TRANCHE_R, msg.sender, address(this), inR, version);
        bytes memory data =
            abi.encode(
                primaryMarket,
                queenSwapOrPrimaryMarketRouter,
                minQuote,
                recipient,
                version,
                externalRouter,
                externalPath
            );
        tranchessRouter.getSwap(pm.fund().tokenB(), tokenQuote).buy(
            version,
            inR,
            address(this),
            data
        );
    }

    function tranchessSwapCallback(
        uint256 baseDeltaOut,
        uint256 quoteDeltaOut,
        bytes calldata data
    ) external override {
        (
            address primaryMarket,
            address queenSwapOrPrimaryMarketRouter,
            uint256 expectAmount,
            address recipient,
            uint256 version,
            ,

        ) = abi.decode(data, (address, address, uint256, address, uint256, address, address[]));
        IPrimaryMarketV3 pm = IPrimaryMarketV3(primaryMarket);
        address tokenQuote = IStableSwap(msg.sender).quoteAddress();
        require(
            msg.sender == address(tranchessRouter.getSwap(tokenQuote, pm.fund().tokenB())),
            "Tranchess Pair check failed"
        );
        if (baseDeltaOut > 0) {
            require(quoteDeltaOut == 0, "Unidirectional check failed");
            uint256 quoteAmount;
            {
                // Calculate the exact amount of quote asset to pay
                address[] memory tranchessPath = new address[](2);
                tranchessPath[0] = tokenQuote;
                tranchessPath[1] = pm.fund().tokenB();
                quoteAmount = tranchessRouter.getAmountsIn(baseDeltaOut, tranchessPath)[0];
            }
            // Merge BISHOP and ROOK into QUEEN
            uint256 outQ = pm.merge(address(this), baseDeltaOut, version);

            // Redeem or swap QUEEN for underlying
            pm.fund().trancheTransfer(TRANCHE_Q, queenSwapOrPrimaryMarketRouter, outQ, version);
            uint256 underlyingAmount =
                IStableSwapCore(queenSwapOrPrimaryMarketRouter).sell(version, 0, address(this), "");

            // Trade underlying for quote asset
            uint256 totalQuoteAmount =
                _externalSwap(data, underlyingAmount, 0, pm.fund().tokenUnderlying(), tokenQuote)[
                    1
                ];
            // Send back quote asset to tranchess swap
            IERC20(tokenQuote).safeTransfer(msg.sender, quoteAmount);
            // Send the rest of quote asset to user
            uint256 resultAmount = totalQuoteAmount.sub(quoteAmount);
            require(resultAmount >= expectAmount, "Insufficient output");
            IERC20(tokenQuote).safeTransfer(recipient, resultAmount);
        } else {
            // Trade quote asset for underlying asset
            uint256 underlyingAmount =
                _externalSwap(
                    data,
                    quoteDeltaOut,
                    expectAmount,
                    tokenQuote,
                    pm.fund().tokenUnderlying()
                )[1];

            // Create or swap borrowed underlying for QUEEN
            IERC20(pm.fund().tokenUnderlying()).safeTransfer(
                queenSwapOrPrimaryMarketRouter,
                underlyingAmount
            );
            uint256 outQ =
                IStableSwapCore(queenSwapOrPrimaryMarketRouter).buy(version, 0, address(this), "");

            // Split QUEEN into BISHOP and ROOK
            uint256 outB = pm.split(address(this), outQ, version);
            // Send back BISHOP to tranchess swap
            pm.fund().trancheTransfer(TRANCHE_B, msg.sender, outB, version);
            // Send ROOK to user
            pm.fund().trancheTransfer(TRANCHE_R, recipient, outB, version);
        }
    }

    function _externalSwap(
        bytes memory data,
        uint256 amountIn,
        uint256 minAmountOut,
        address tokenIn,
        address tokenOut
    ) private returns (uint256[] memory amounts) {
        (, , , , , address externalRouter, address[] memory externalPath) =
            abi.decode(data, (address, address, uint256, address, uint256, address, address[]));
        require(externalPath.length > 1, "Invalid external path");
        require(externalPath[0] == tokenIn, "Invalid token in");
        require(externalPath[externalPath.length - 1] == tokenOut, "Invalid token out");
        amounts = IUniswapV2Router01(externalRouter).swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            externalPath,
            address(this),
            block.timestamp
        );
    }
}
