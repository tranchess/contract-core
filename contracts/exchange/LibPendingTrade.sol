// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

struct PendingBuyTrade {
    uint256 frozenQuote; // Amount of quote assets frozen for settlement
    uint256 effectiveQuote; // Amount of quote assets in effect
    uint256 reservedBase; // Amount of base assets spent
}

struct PendingSellTrade {
    uint256 frozenBase; // Amount of base assets frozen for settlement
    uint256 effectiveBase; // Amount of base assets in effect
    uint256 reservedQuote; // Amount of quote assets spent
}

/// @notice Pending trades of an account
struct PendingTrade {
    PendingBuyTrade takerBuy; // Buy trades as taker
    PendingSellTrade takerSell; // Sell trades as taker
    PendingSellTrade makerBuy; // Buy trades as maker
    PendingBuyTrade makerSell; // Sell trades as maker
}

library LibPendingBuyTrade {
    using SafeMath for uint256;

    /// @dev Accumulate buy trades
    /// @param self Trade to update
    /// @param other New trade to be added to storage
    function add(PendingBuyTrade storage self, PendingBuyTrade memory other) internal {
        self.frozenQuote = self.frozenQuote.add(other.frozenQuote);
        self.effectiveQuote = self.effectiveQuote.add(other.effectiveQuote);
        self.reservedBase = self.reservedBase.add(other.reservedBase);
    }
}

library LibPendingSellTrade {
    using SafeMath for uint256;

    /// @dev Accumulate sell trades
    /// @param self Trade to update
    /// @param other New trade to be added to storage
    function add(PendingSellTrade storage self, PendingSellTrade memory other) internal {
        self.frozenBase = self.frozenBase.add(other.frozenBase);
        self.effectiveBase = self.effectiveBase.add(other.effectiveBase);
        self.reservedQuote = self.reservedQuote.add(other.reservedQuote);
    }
}
