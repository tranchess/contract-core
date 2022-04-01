// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IFundV3.sol";
import "../utils/SafeDecimalMath.sol";
import "./StableSwap.sol";

contract StableSwapNoRebalance is StableSwap {
    using SafeDecimalMath for uint256;

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
        uint256 adminFeeRate_
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
    {}

    function handleRebalance() public override {
        uint256 rebalanceVersion = IFundV3(fund).getRebalanceSize();
        uint256 currentVersion = currentRebalanceVersion;

        if (currentVersion < rebalanceVersion) {
            (baseBalance, , ) = IFundV3(fund).batchRebalance(
                baseBalance,
                0,
                0,
                currentVersion,
                rebalanceVersion
            );
            IFundV3(fund).refreshBalance(address(this), rebalanceVersion);
        }
    }

    function checkOracle(
        Operation /*op*/
    ) public view override returns (uint256 oracle) {
        uint256 fundUnderlying = IFundV3(fund).getTotalUnderlying();
        uint256 fundTotalShares = IFundV3(fund).getTotalShares();
        return fundUnderlying.divideDecimal(fundTotalShares);
    }
}
