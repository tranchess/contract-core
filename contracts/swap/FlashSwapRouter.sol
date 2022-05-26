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
        IFundV3 fund,
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
        uint256 underlyingAmount;
        uint256 totalQuoteAmount;
        {
            uint256 inQ = IPrimaryMarketV3(fund.primaryMarket()).getSplitForB(outR);
            underlyingAmount = IStableSwapCore(queenSwapOrPrimaryMarketRouter).getQuoteIn(inQ);
            // Calculate the exact amount of quote asset to pay
            totalQuoteAmount = IUniswapV2Router01(externalRouter).getAmountsIn(
                underlyingAmount,
                externalPath
            )[0];
        }
        // Arrange the stable swap path
        IStableSwap tranchessPair = tranchessRouter.getSwap(fund.tokenB(), tokenQuote);
        // Calculate the amount of quote asset for selling BISHOP
        uint256 quoteAmount = tranchessPair.getQuoteOut(outR);
        // Send the user's portion of the payment to Tranchess swap
        uint256 resultAmount = totalQuoteAmount.sub(quoteAmount);
        require(resultAmount <= maxQuote, "Excessive input");
        bytes memory data =
            abi.encode(
                fund,
                queenSwapOrPrimaryMarketRouter,
                totalQuoteAmount,
                recipient,
                version,
                externalRouter,
                externalPath
            );
        IERC20(tokenQuote).safeTransferFrom(msg.sender, address(this), resultAmount);
        tranchessPair.sell(version, quoteAmount, address(this), data);
    }

    function sellR(
        IFundV3 fund,
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
        // Send the user's ROOK to this router
        fund.trancheTransferFrom(TRANCHE_R, msg.sender, address(this), inR, version);
        bytes memory data =
            abi.encode(
                fund,
                queenSwapOrPrimaryMarketRouter,
                minQuote,
                recipient,
                version,
                externalRouter,
                externalPath
            );
        tranchessRouter.getSwap(fund.tokenB(), tokenQuote).buy(version, inR, address(this), data);
    }

    function tranchessSwapCallback(
        uint256 baseOut,
        uint256 quoteOut,
        bytes calldata data
    ) external override {
        (
            IFundV3 fund,
            address queenSwapOrPrimaryMarketRouter,
            uint256 expectQuoteAmount,
            address recipient,
            uint256 version,
            ,

        ) = abi.decode(data, (IFundV3, address, uint256, address, uint256, address, address[]));
        address tokenQuote = IStableSwap(msg.sender).quoteAddress();
        require(
            msg.sender == address(tranchessRouter.getSwap(tokenQuote, fund.tokenB())),
            "Tranchess Pair check failed"
        );
        if (baseOut > 0) {
            require(quoteOut == 0, "Unidirectional check failed");
            uint256 quoteAmount = IStableSwap(msg.sender).getQuoteIn(baseOut);
            // Merge BISHOP and ROOK into QUEEN
            uint256 outQ =
                IPrimaryMarketV3(fund.primaryMarket()).merge(address(this), baseOut, version);

            // Redeem or swap QUEEN for underlying
            fund.trancheTransfer(TRANCHE_Q, queenSwapOrPrimaryMarketRouter, outQ, version);
            uint256 underlyingAmount =
                IStableSwapCore(queenSwapOrPrimaryMarketRouter).sell(version, 0, address(this), "");

            // Trade underlying for quote asset
            uint256 totalQuoteAmount =
                _externalSwap(data, underlyingAmount, fund.tokenUnderlying(), tokenQuote)[1];
            // Send back quote asset to tranchess swap
            IERC20(tokenQuote).safeTransfer(msg.sender, quoteAmount);
            // Send the rest of quote asset to user
            uint256 resultAmount = totalQuoteAmount.sub(quoteAmount);
            require(resultAmount >= expectQuoteAmount, "Insufficient output");
            IERC20(tokenQuote).safeTransfer(recipient, resultAmount);
        } else {
            address tokenUnderlying = fund.tokenUnderlying();
            // Trade quote asset for underlying asset
            uint256 underlyingAmount =
                _externalSwap(data, expectQuoteAmount, tokenQuote, tokenUnderlying)[1];

            // Create or swap borrowed underlying for QUEEN
            IERC20(tokenUnderlying).safeTransfer(queenSwapOrPrimaryMarketRouter, underlyingAmount);
            uint256 outQ =
                IStableSwapCore(queenSwapOrPrimaryMarketRouter).buy(version, 0, address(this), "");

            // Split QUEEN into BISHOP and ROOK
            uint256 outB =
                IPrimaryMarketV3(fund.primaryMarket()).split(address(this), outQ, version);
            // Send back BISHOP to tranchess swap
            fund.trancheTransfer(TRANCHE_B, msg.sender, outB, version);
            // Send ROOK to user
            fund.trancheTransfer(TRANCHE_R, recipient, outB, version);
        }
    }

    function _externalSwap(
        bytes memory data,
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) private returns (uint256[] memory amounts) {
        (, , , , , address externalRouter, address[] memory externalPath) =
            abi.decode(data, (address, address, uint256, address, uint256, address, address[]));
        require(externalPath.length > 1, "Invalid external path");
        require(externalPath[0] == tokenIn, "Invalid token in");
        require(externalPath[externalPath.length - 1] == tokenOut, "Invalid token out");
        IERC20(tokenIn).safeApprove(externalRouter, amountIn);
        amounts = IUniswapV2Router01(externalRouter).swapExactTokensForTokens(
            amountIn,
            0,
            externalPath,
            address(this),
            block.timestamp
        );
    }
}
