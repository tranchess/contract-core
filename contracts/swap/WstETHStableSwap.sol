// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IWstETH.sol";
import "./StableSwapV3.sol";

abstract contract WstETHStableSwap is StableSwapV3, ITrancheIndexV2 {
    event Rebalanced(uint256 base, uint256 quote, uint256 version);

    address public immutable wstETH;

    uint256 public currentVersion;

    constructor(
        address lpToken_,
        address fund_,
        uint256 baseTranche_,
        address quoteAddress_,
        uint256 quoteDecimals_,
        uint256 ampl_,
        address feeCollector_,
        uint256 feeRate_,
        uint256 adminFeeRate_
    )
        public
        StableSwapV3(
            lpToken_,
            fund_,
            baseTranche_,
            quoteAddress_,
            quoteDecimals_,
            ampl_,
            feeCollector_,
            feeRate_,
            adminFeeRate_
        )
    {
        require(quoteAddress_ == IFundV3(fund_).tokenUnderlying());
        wstETH = quoteAddress_;
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
        returns (RebalanceResult memory result, uint256 excessiveQ, uint256, uint256, uint256)
    {
        result.quote = quoteBalance;
        if (latestVersion == currentVersion) {
            result.base = baseBalance;
            return (result, 0, 0, 0, 0);
        }
        result.rebalanceTimestamp = latestVersion == 0
            ? 0
            : fund.getRebalanceTimestamp(latestVersion - 1);
        (excessiveQ, result.base, ) = fund.batchRebalance(
            0,
            baseBalance,
            0,
            currentVersion,
            latestVersion
        );
    }

    function _handleRebalance(
        uint256 latestVersion
    ) internal override returns (RebalanceResult memory result) {
        uint256 excessiveQ;
        (result, excessiveQ, , , ) = _getRebalanceResult(latestVersion);
        if (result.rebalanceTimestamp != 0) {
            baseBalance = result.base;
            quoteBalance = result.quote;
            currentVersion = latestVersion;
            emit Rebalanced(result.base, result.quote, latestVersion);
            if (excessiveQ > 0) {
                fund.trancheTransfer(TRANCHE_Q, lpToken, excessiveQ, latestVersion);
            }
            ILiquidityGauge(lpToken).distribute(excessiveQ, 0, 0, 0, latestVersion);
        }
    }

    function getOraclePrice() public view override returns (uint256) {
        uint256 baseNav = _getBaseNav();
        return baseNav.divideDecimal(IWstETH(wstETH).stEthPerToken());
    }

    function _rebalanceBase(
        uint256 oldBase,
        uint256 fromVersion,
        uint256 toVersion
    ) internal view virtual returns (uint256 excessiveQ, uint256 newBase);

    function _getBaseNav() internal view virtual returns (uint256);
}
