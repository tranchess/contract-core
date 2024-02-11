// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "./WstETHStableSwap.sol";

contract WstETHRookStableSwap is WstETHStableSwap {
    event Rebalanced(uint256 base, uint256 quote, uint256 version);

    constructor(
        address lpToken_,
        address fund_,
        address quoteAddress_,
        uint256 quoteDecimals_,
        uint256 ampl_,
        address feeCollector_,
        uint256 feeRate_,
        uint256 adminFeeRate_
    )
        public
        WstETHStableSwap(
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
    {}

    function _rebalanceBase(
        uint256 oldBase,
        uint256 fromVersion,
        uint256 toVersion
    ) internal view override returns (uint256 excessiveQ, uint256 newBase) {
        (excessiveQ, , newBase) = fund.batchRebalance(0, 0, oldBase, fromVersion, toVersion);
    }

    function _getBaseNav() internal view override returns (uint256) {
        uint256 price = fund.twapOracle().getLatest();
        (, , uint256 navR) = fund.extrapolateNav(price);
        return navR;
    }
}
