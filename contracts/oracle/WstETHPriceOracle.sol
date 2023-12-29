// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/ITwapOracleV2.sol";
import "../interfaces/IWstETH.sol";

/// @title wstETH Price oracle
/// @author Tranchess
contract WstETHPriceOracle is ITwapOracleV2 {
    IWstETH public immutable wstETH;

    constructor(address wstETH_) public {
        wstETH = IWstETH(wstETH_);
    }

    /// @notice Return the latest price with 18 decimal places.
    function getLatest() external view override returns (uint256) {
        return wstETH.stEthPerToken();
    }

    /// @notice For wstETH price oracle, we keep the `getTwap` interface
    ///         compatible but it only returns the latest price.
    function getTwap(uint256) external view override returns (uint256) {
        return wstETH.stEthPerToken();
    }
}
