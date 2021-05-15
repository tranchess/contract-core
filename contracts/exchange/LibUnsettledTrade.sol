// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

struct UnsettledBuyTrade {
    uint256 frozenQuote; // Amount of quote assets frozen for settlement
    uint256 effectiveQuote; // Amount of quote assets in effect
    uint256 reservedBase; // Amount of base assets spent
}

struct UnsettledSellTrade {
    uint256 frozenBase; // Amount of base assets frozen for settlement
    uint256 effectiveBase; // Amount of base assets in effect
    uint256 reservedQuote; // Amount of quote assets spent
}

/// @notice Unsettled trades of an account
struct UnsettledTrade {
    UnsettledBuyTrade takerBuy; // Buy trades as taker
    UnsettledSellTrade takerSell; // Sell trades as taker
    UnsettledSellTrade makerBuy; // Buy trades as maker
    UnsettledBuyTrade makerSell; // Sell trades as maker
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
