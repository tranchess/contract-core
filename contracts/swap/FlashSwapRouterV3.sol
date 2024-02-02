// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/ITranchessSwapCallee.sol";
import "../interfaces/IFundV5.sol";
import "../interfaces/IPrimaryMarketV5.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IWstETH.sol";

/// @title Tranchess Flash Swap Router
/// @notice Router for stateless execution of flash swaps against Tranchess stable swaps
contract FlashSwapRouterV3 is ITranchessSwapCallee, ITrancheIndexV2, Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    event SwapRook(
        address indexed recipient,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 baseOut,
        uint256 quoteOut
    );

    ISwapRouter public immutable tranchessRouter;

    constructor(address tranchessRouter_) public {
        tranchessRouter = ISwapRouter(tranchessRouter_);
    }

    /// @dev Only meant for an off-chain client to call with eth_call.
    function getBuyR(
        IFundV5 fund,
        bool needWrap,
        address queenSwapOrPrimaryMarketRouter,
        address tokenQuote,
        uint256 outR
    ) external returns (uint256 quoteDelta, uint256 rookDelta) {
        (uint256 inQ, uint256 outB) = IPrimaryMarketV5(fund.primaryMarket()).getSplitForR(outR);
        uint256 totalQuoteAmount = IStableSwapCoreInternalRevertExpected(
            queenSwapOrPrimaryMarketRouter
        ).getQuoteIn(inQ);
        // Calculate the amount of quote asset for selling BISHOP
        IStableSwap tranchessPair = tranchessRouter.getSwap(fund.tokenB(), tokenQuote);
        uint256 quoteAmount = tranchessPair.getQuoteOut(outB);
        // Calculate the user's portion of the payment to Tranchess swap
        quoteDelta = totalQuoteAmount.sub(quoteAmount);
        if (needWrap) {
            quoteDelta = IWstETH(tokenQuote).getStETHByWstETH(quoteDelta).add(1);
        }
        // Calculate creation of borrowed underlying for QUEEN
        uint256 outQ = IStableSwapCoreInternalRevertExpected(queenSwapOrPrimaryMarketRouter)
            .getBaseOut(totalQuoteAmount);
        // Calculate the split result of QUEEN into BISHOP and ROOK
        (, rookDelta) = IPrimaryMarketV5(fund.primaryMarket()).getSplit(outQ);
    }

    /// @dev Only meant for an off-chain client to call with eth_call.
    function getSellR(
        IFundV5 fund,
        bool needUnwrap,
        address queenSwapOrPrimaryMarketRouter,
        address tokenQuote,
        uint256 inR
    ) external returns (uint256 quoteDelta, uint256 rookDelta) {
        rookDelta = inR;
        // Calculate merge result of BISHOP and ROOK into QUEEN
        (uint256 inB, uint256 outQ, ) = IPrimaryMarketV5(fund.primaryMarket()).getMergeByR(inR);
        uint256 quoteAmount = IStableSwap(tranchessRouter.getSwap(fund.tokenB(), tokenQuote))
            .getQuoteIn(inB);
        // Calculate the redemption from QUEEN to underlying
        uint256 totalQuoteAmount = IStableSwapCoreInternalRevertExpected(
            queenSwapOrPrimaryMarketRouter
        ).getQuoteOut(outQ);
        // Calculate the rest of quote asset to user
        quoteDelta = totalQuoteAmount.sub(quoteAmount);
        if (needUnwrap) {
            quoteDelta = IWstETH(tokenQuote).getStETHByWstETH(quoteDelta);
        }
    }

    function buyR(
        IFundV5 fund,
        bool needWrap,
        address queenSwapOrPrimaryMarketRouter,
        uint256 maxQuote,
        address recipient,
        address tokenQuote,
        uint256 version,
        uint256 outR
    ) external {
        (uint256 inQ, uint256 outB) = IPrimaryMarketV5(fund.primaryMarket()).getSplitForR(outR);
        // Calculate the exact amount of quote asset to pay
        uint256 totalQuoteAmount = IStableSwapCoreInternalRevertExpected(
            queenSwapOrPrimaryMarketRouter
        ).getQuoteIn(inQ);
        // Arrange the stable swap path
        IStableSwap tranchessPair = tranchessRouter.getSwap(fund.tokenB(), tokenQuote);
        // Calculate the amount of quote asset for selling BISHOP
        uint256 quoteAmount = tranchessPair.getQuoteOut(outB);
        // Send the user's portion of the payment to Tranchess swap
        uint256 resultAmount = totalQuoteAmount.sub(quoteAmount);
        if (needWrap) {
            address stETH = IWstETH(tokenQuote).stETH();
            uint256 unwrappedAmount = IWstETH(tokenQuote).getStETHByWstETH(resultAmount).add(1);
            require(unwrappedAmount <= maxQuote, "Excessive input");
            IERC20(stETH).safeTransferFrom(msg.sender, address(this), unwrappedAmount);
            IERC20(stETH).approve(tokenQuote, unwrappedAmount);
            resultAmount = IWstETH(tokenQuote).wrap(unwrappedAmount);
            totalQuoteAmount = quoteAmount.add(resultAmount);
        } else {
            require(resultAmount <= maxQuote, "Excessive input");
            IERC20(tokenQuote).safeTransferFrom(msg.sender, address(this), resultAmount);
        }
        bytes memory data = abi.encode(
            fund,
            queenSwapOrPrimaryMarketRouter,
            totalQuoteAmount,
            recipient,
            version
        );
        tranchessPair.sell(version, quoteAmount, address(this), data);
        emit SwapRook(recipient, 0, resultAmount, outR, 0);
    }

    function sellR(
        IFundV5 fund,
        bool needUnwrap,
        address queenSwapOrPrimaryMarketRouter,
        uint256 minQuote,
        address recipient,
        address tokenQuote,
        uint256 version,
        uint256 inR
    ) external {
        // Calculate merge result of BISHOP and ROOK into QUEEN
        (uint256 inB, , ) = IPrimaryMarketV5(fund.primaryMarket()).getMergeByR(inR);
        // Send the user's ROOK to this router
        fund.trancheTransferFrom(TRANCHE_R, msg.sender, address(this), inR, version);
        bytes memory data = abi.encode(
            fund,
            queenSwapOrPrimaryMarketRouter,
            minQuote,
            recipient,
            version
        );
        tranchessRouter.getSwap(fund.tokenB(), tokenQuote).buy(version, inB, address(this), data);
        // Send the rest of quote asset to user
        uint256 resultAmount = IERC20(tokenQuote).balanceOf(address(this));
        if (needUnwrap) {
            uint256 unwrappedAmount = IWstETH(tokenQuote).unwrap(resultAmount);
            require(unwrappedAmount >= minQuote, "Insufficient output");
            IERC20(IWstETH(tokenQuote).stETH()).safeTransfer(recipient, unwrappedAmount);
        } else {
            require(resultAmount >= minQuote, "Insufficient output");
            IERC20(tokenQuote).safeTransfer(recipient, resultAmount);
        }
        emit SwapRook(recipient, inR, 0, 0, resultAmount);
    }

    function tranchessSwapCallback(
        uint256 baseOut,
        uint256 quoteOut,
        bytes calldata data
    ) external override {
        (
            IFundV5 fund,
            address queenSwapOrPrimaryMarketRouter,
            uint256 expectQuoteAmount,
            address recipient,
            uint256 version
        ) = abi.decode(data, (IFundV5, address, uint256, address, uint256));
        address tokenQuote = IStableSwap(msg.sender).quoteAddress();
        require(
            msg.sender == address(tranchessRouter.getSwap(tokenQuote, fund.tokenB())),
            "Tranchess Pair check failed"
        );
        if (baseOut > 0) {
            require(quoteOut == 0, "Unidirectional check failed");
            uint256 quoteAmount = IStableSwap(msg.sender).getQuoteIn(baseOut);
            // Merge BISHOP and ROOK into QUEEN
            uint256 outQ = IPrimaryMarketV5(fund.primaryMarket()).merge(
                queenSwapOrPrimaryMarketRouter,
                baseOut,
                version
            );
            // Redeem or swap QUEEN for underlying
            uint256 underlyingAmount = IStableSwapCoreInternalRevertExpected(
                queenSwapOrPrimaryMarketRouter
            ).getQuoteOut(outQ);
            IStableSwapCoreInternalRevertExpected(queenSwapOrPrimaryMarketRouter).sell(
                version,
                underlyingAmount,
                address(this),
                ""
            );
            // Send back quote asset to tranchess swap
            IERC20(tokenQuote).safeTransfer(msg.sender, quoteAmount);
        } else {
            address tokenUnderlying = fund.tokenUnderlying();
            // Create or swap borrowed underlying for QUEEN
            uint256 outQ = IStableSwapCoreInternalRevertExpected(queenSwapOrPrimaryMarketRouter)
                .getBaseOut(expectQuoteAmount);
            IERC20(tokenUnderlying).safeTransfer(queenSwapOrPrimaryMarketRouter, expectQuoteAmount);
            outQ = IStableSwapCoreInternalRevertExpected(queenSwapOrPrimaryMarketRouter).buy(
                version,
                outQ,
                address(this),
                ""
            );
            // Split QUEEN into BISHOP and ROOK
            (uint256 outB, uint256 outR) = IPrimaryMarketV5(fund.primaryMarket()).split(
                address(this),
                outQ,
                version
            );
            // Send back BISHOP to tranchess swap
            fund.trancheTransfer(TRANCHE_B, msg.sender, outB, version);
            // Send ROOK to user
            fund.trancheTransfer(TRANCHE_R, recipient, outR, version);
        }
    }
}
