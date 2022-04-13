// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

import "../interfaces/IPrimaryMarketV3.sol";
import "./StableSwap.sol";

contract StableSwapRebalance is StableSwap {
    uint256 public immutable tradingCurbThreshold;
    address public immutable chainlinkAggregator;

    constructor(
        address lpToken_,
        address fund_,
        uint256 baseTranche_,
        address quoteAddress_,
        uint256 initialAmpl_,
        uint256 futureAmpl_,
        address feeCollector_,
        uint256 feeRate_,
        uint256 adminFeeRate_,
        address chainlinkAggregator_,
        uint256 tradingCurbThreshold_
    )
        public
        StableSwap(
            lpToken_,
            fund_,
            baseTranche_,
            quoteAddress_,
            initialAmpl_,
            futureAmpl_,
            feeCollector_,
            feeRate_,
            adminFeeRate_
        )
    {
        tradingCurbThreshold = tradingCurbThreshold_;
        chainlinkAggregator = chainlinkAggregator_;
    }

    /// @dev Handle the rebalance immediately. Should be called before any swap operation.
    function handleRebalance() public override returns (uint256 rebalanceVersion) {
        rebalanceVersion = fund.getRebalanceSize();
        uint256 baseBalance_ = baseBalance;
        uint256 currentVersion = currentRebalanceVersion;

        if (currentVersion < rebalanceVersion) {
            (uint256 amountQ, uint256 amountB, ) =
                fund.batchRebalance(0, baseBalance_, 0, currentVersion, rebalanceVersion);
            fund.refreshBalance(address(this), rebalanceVersion);
            uint256 amountU;

            if (baseBalance_ > amountB) {
                // RatioBR < 1
                uint256 quoteBalance_ = quoteBalance;
                uint256 outB =
                    IPrimaryMarketV3(fund.primaryMarket()).split(
                        address(this),
                        amountQ,
                        rebalanceVersion
                    );
                uint256 newBalance0 = amountB.add(outB);
                amountU = quoteBalance_.mul(baseBalance_.sub(newBalance0)).div(baseBalance_);
                baseBalance = newBalance0;
                quoteBalance = quoteBalance_.sub(amountU);
                IERC20(quoteAddress).safeTransfer(lpToken, amountU);
                IERC20(fund.tokenR()).safeTransfer(lpToken, outB);
                ILiquidityGauge(lpToken).snapshot(0, 0, outB, amountU, rebalanceVersion);
            } else if (baseBalance_ < amountB) {
                // RatioBR > 1
                amountB = amountB - baseBalance_;
                IERC20(fund.tokenQ()).safeTransfer(lpToken, amountQ);
                IERC20(fund.tokenB()).safeTransfer(lpToken, amountB);
                ILiquidityGauge(lpToken).snapshot(amountQ, amountB, 0, 0, rebalanceVersion);
            } else {
                // RatioBR == 1
                IERC20(fund.tokenQ()).safeTransfer(lpToken, amountQ);
                ILiquidityGauge(lpToken).snapshot(amountQ, 0, 0, 0, rebalanceVersion);
            }
        }

        currentRebalanceVersion = rebalanceVersion;
    }

    modifier checkActivity() override {
        require(currentRebalanceVersion == fund.getRebalanceSize(), "Transaction too old");
        _;
    }

    function checkOracle(Operation op) public view override returns (uint256 oracle) {
        (, int256 answer, , , ) = AggregatorV3Interface(chainlinkAggregator).latestRoundData();
        (, uint256 navB, uint256 navR) = fund.extrapolateNav(uint256(answer));
        if (op == Operation.SWAP || op == Operation.ADD_LIQUIDITY) {
            require(navR >= navB.multiplyDecimal(tradingCurbThreshold), "Trading curb");
        }
        return navB;
    }
}
