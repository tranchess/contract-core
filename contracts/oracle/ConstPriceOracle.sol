// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/ITwapOracleV2.sol";

/// @title Constant Price oracle
/// @author Tranchess
contract ConstPriceOracle is ITwapOracleV2 {
    uint256 public immutable price;

    constructor(uint256 price_) public {
        price = price_;
    }

    /// @notice Return the constant price with 18 decimal places.
    function getLatest() external view override returns (uint256) {
        return price;
    }

    /// @notice For constant price oracle, we keep the `getTwap` interface
    ///         compatible but it only returns the constant price.
    function getTwap(uint256) external view override returns (uint256) {
        return price;
    }
}
