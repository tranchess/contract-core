// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

/// @notice Unsettled trade of a taker buy order or a maker sell order
/// @param frozenQuote Amount of quote assets from the taker
/// @param effectiveQuote Effective amount of quote assets at zero premium-discount
/// @param reservedBase Reserved amount of base assets from the maker
struct UnsettledBuyTrade {
    uint256 frozenQuote;
    uint256 effectiveQuote;
    uint256 reservedBase;
}

/// @notice Unsettled trade of a taker sell order or a maker buy order
/// @param frozenBase Amount of base assets from the taker
/// @param effectiveBase Effective amount of base assets at zero premium-discount
/// @param reservedQuote Reserved amount of quote assets from the maker
struct UnsettledSellTrade {
    uint256 frozenBase;
    uint256 effectiveBase;
    uint256 reservedQuote;
}

/// @notice Unsettled trades of an account in a single epoch
/// @param takerBuy Trade by taker buy orders
/// @param takerSell Trade by taker sell orders
/// @param makerBuy Trade by maker buy orders
/// @param makerSell Trade by maker sell orders
struct UnsettledTrade {
    UnsettledBuyTrade takerBuy;
    UnsettledSellTrade takerSell;
    UnsettledSellTrade makerBuy;
    UnsettledBuyTrade makerSell;
}

library LibUnsettledBuyTrade {
    using SafeMath for uint256;

    /// @dev Accumulate buy trades
    /// @param self Trade to update
    /// @param other New trade to be added to storage
    function add(UnsettledBuyTrade storage self, UnsettledBuyTrade memory other) internal {
        self.frozenQuote = self.frozenQuote.add(other.frozenQuote);
        self.effectiveQuote = self.effectiveQuote.add(other.effectiveQuote);
        self.reservedBase = self.reservedBase.add(other.reservedBase);
    }
}

library LibUnsettledSellTrade {
    using SafeMath for uint256;

    /// @dev Accumulate sell trades
    /// @param self Trade to update
    /// @param other New trade to be added to storage
    function add(UnsettledSellTrade storage self, UnsettledSellTrade memory other) internal {
        self.frozenBase = self.frozenBase.add(other.frozenBase);
        self.effectiveBase = self.effectiveBase.add(other.effectiveBase);
        self.reservedQuote = self.reservedQuote.add(other.reservedQuote);
    }
}
