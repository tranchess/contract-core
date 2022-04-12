// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IPrimaryMarketV3.sol";
import "./StableSwap.sol";

contract StableSwapRebalance is StableSwap {
    uint256 public immutable tradingCurbThreshold;
    address public immutable chainlinkAggregator;

    constructor(
        address fund_,
        address primaryMarket_,
        address lpToken_,
        address baseAddress_,
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
            fund_,
            primaryMarket_,
            lpToken_,
            baseAddress_,
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
    function handleRebalance() public override {
        uint256 rebalanceVersion = IFundV3(fund).getRebalanceSize();
        uint256 baseBalance_ = baseBalance;
        uint256 currentVersion = currentRebalanceVersion;

        if (currentVersion < rebalanceVersion) {
            (uint256 amountM, uint256 amountA, ) =
                IFundV3(fund).batchRebalance(0, baseBalance_, 0, currentVersion, rebalanceVersion);
            IFundV3(fund).refreshBalance(address(this), rebalanceVersion);
            uint256 amountU;

            if (baseBalance_ > amountA) {
                // RatioAB < 1
                uint256 quoteBalance_ = quoteBalance;
                uint256 outAB =
                    IPrimaryMarketV3(primaryMarket).split(address(this), amountM, rebalanceVersion);
                uint256 newBalance0 = amountA.add(outAB);
                amountU = quoteBalance_.mul(baseBalance_.sub(newBalance0)).div(baseBalance_);
                baseBalance = newBalance0;
                quoteBalance = quoteBalance_.sub(amountU);
                IERC20(quoteAddress).safeTransfer(lpToken, amountU);
                IERC20(IFundV3(fund).tokenB()).safeTransfer(lpToken, outAB);
                ILiquidityGauge(lpToken).snapshot(0, 0, outAB, amountU, rebalanceVersion);
            } else if (baseBalance_ < amountA) {
                // RatioAB > 1
                amountA = amountA - baseBalance_;
                IERC20(IFundV3(fund).tokenM()).safeTransfer(lpToken, amountM);
                IERC20(IFundV3(fund).tokenA()).safeTransfer(lpToken, amountA);
                ILiquidityGauge(lpToken).snapshot(amountM, amountA, 0, 0, rebalanceVersion);
            } else {
                // RatioAB == 1
                IERC20(IFundV3(fund).tokenM()).safeTransfer(lpToken, amountM);
                ILiquidityGauge(lpToken).snapshot(amountM, 0, 0, 0, rebalanceVersion);
            }
        }

        currentRebalanceVersion = rebalanceVersion;
    }

    modifier checkActivity() override {
        require(currentRebalanceVersion == IFundV3(fund).getRebalanceSize(), "Transaction too old");
        _;
    }

    function checkOracle(Operation op) public view override returns (uint256 oracle) {
        (, int256 answer, , , ) = AggregatorV3Interface(chainlinkAggregator).latestRoundData();
        (, uint256 navA, uint256 navB) = IFundV3(fund).extrapolateNav(uint256(answer));
        if (op == Operation.SWAP || op == Operation.ADD_LIQUIDITY) {
            require(navB >= navA.multiplyDecimal(tradingCurbThreshold), "Trading curb");
        }
        return navA;
    }
}
