// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

import "../interfaces/IPrimaryMarketV5.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "./StableSwapV2.sol";

contract RookStableSwapV2 is StableSwapV2, ITrancheIndexV2 {
    event Rebalanced(uint256 base, uint256 quote, uint256 version);

    uint256 public immutable tradingCurbThreshold;

    uint256 public currentVersion;

    constructor(
        address lpToken_,
        address fund_,
        address quoteAddress_,
        uint256 quoteDecimals_,
        uint256 ampl_,
        address feeCollector_,
        uint256 feeRate_,
        uint256 adminFeeRate_,
        uint256 tradingCurbThreshold_
    )
        public
        StableSwapV2(
            lpToken_,
            fund_,
            TRANCHE_R,
            quoteAddress_,
            quoteDecimals_,
            ampl_,
            feeCollector_,
            feeRate_,
            adminFeeRate_
        )
    {
        tradingCurbThreshold = tradingCurbThreshold_;
        currentVersion = IFundV3(fund_).getRebalanceSize();
    }

    /// @dev Make sure the user-specified version is the latest rebalance version.
    function _checkVersion(uint256 version) internal view override {
        require(version == fund.getRebalanceSize(), "Obsolete rebalance version");
    }

    function _getRebalanceResult(
        uint256 latestVersion
    )
        internal
        view
        override
        returns (
            uint256 newBase,
            uint256 newQuote,
            uint256 excessiveQ,
            uint256 excessiveB,
            uint256 excessiveR,
            uint256 excessiveQuote,
            bool isRebalanced
        )
    {
        if (latestVersion == currentVersion) {
            return (baseBalance, quoteBalance, 0, 0, 0, 0, false);
        }
        isRebalanced = true;

        uint256 oldBaseBalance = baseBalance;
        uint256 oldQuoteBalance = quoteBalance;
        (excessiveQ, newBase, ) = fund.batchRebalance(
            0,
            oldBaseBalance,
            0,
            currentVersion,
            latestVersion
        );
        if (newBase < oldBaseBalance) {
            // We split all QUEEN from rebalance if the amount of ROOK is smaller than before.
            // In almost all cases, the total amount of ROOK after the split is still smaller
            // than before.
            (excessiveB, excessiveR) = IPrimaryMarketV5(fund.primaryMarket()).getSplit(excessiveQ);
            newBase = newBase.add(excessiveR);
        }
        if (newBase < oldBaseBalance) {
            // If ROOK amount is still smaller than before, we remove quote tokens proportionally.
            newQuote = oldQuoteBalance.mul(newBase).div(oldBaseBalance);
            excessiveQuote = oldQuoteBalance - newQuote;
        } else {
            // In most cases when we reach here, the ROOK amount remains the same (ratioBR = 1).
            newQuote = oldQuoteBalance;
            excessiveR = newBase - oldBaseBalance;
            newBase = oldBaseBalance;
        }
    }

    function _handleRebalance(
        uint256 latestVersion
    ) internal override returns (uint256 newBase, uint256 newQuote) {
        uint256 excessiveQ;
        uint256 excessiveB;
        uint256 excessiveR;
        uint256 excessiveQuote;
        bool isRebalanced;
        (
            newBase,
            newQuote,
            excessiveQ,
            excessiveB,
            excessiveR,
            excessiveQuote,
            isRebalanced
        ) = _getRebalanceResult(latestVersion);
        if (isRebalanced) {
            baseBalance = newBase;
            quoteBalance = newQuote;
            currentVersion = latestVersion;
            emit Rebalanced(newBase, newQuote, latestVersion);
            if (excessiveQ > 0) {
                if (excessiveR > 0) {
                    IPrimaryMarketV5(fund.primaryMarket()).split(
                        address(this),
                        excessiveQ,
                        latestVersion
                    );
                    excessiveQ = 0;
                } else {
                    fund.trancheTransfer(TRANCHE_Q, lpToken, excessiveQ, latestVersion);
                }
            }
            if (excessiveB > 0) {
                fund.trancheTransfer(TRANCHE_B, lpToken, excessiveB, latestVersion);
            }
            if (excessiveR > 0) {
                fund.trancheTransfer(TRANCHE_R, lpToken, excessiveR, latestVersion);
            }
            if (excessiveQuote > 0) {
                IERC20(quoteAddress).safeTransfer(lpToken, excessiveQuote);
            }
            ILiquidityGauge(lpToken).distribute(
                excessiveQ,
                excessiveB,
                excessiveR,
                excessiveQuote,
                latestVersion
            );
        }
    }

    function getOraclePrice() public view override returns (uint256) {
        uint256 price = fund.twapOracle().getLatest(); // wstETH / stETH
        (, uint256 navB, uint256 navR) = fund.extrapolateNav(price); // ETH / ROOK
        return navR.multiplyDecimal(price); // wstETH / ROOK
    }
}
