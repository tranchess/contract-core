// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

struct DelayedRedemptionItem {
    uint192 underlying;
    uint64 next;
}

struct DelayedRedemptionHeadTail {
    uint64 head;
    uint64 tail;
}

/// @notice Delayed redemption
/// @param frozenQuote Amount of quote assets from the taker
/// @param effectiveQuote Effective amount of quote assets at zero premium-discount
/// @param reservedBase Reserved amount of base assets from the maker
struct DelayedRedemption {
    DelayedRedemptionHeadTail headTail;
    mapping(uint64 => DelayedRedemptionItem) list;
}

library LibDelayedRedemption {
    using SafeMath for uint256;

    function get(DelayedRedemption storage self, uint256 day)
        internal
        view
        returns (uint256, uint256)
    {
        DelayedRedemptionItem memory item = self.list[uint64(day)];
        return (item.underlying, item.next);
    }

    /// @dev Append an item to the list.
    /// @param self The list to update
    /// @param underlying Redemption underlying amount
    /// @param day Trading day of the redemption
    function pushBack(
        DelayedRedemption storage self,
        uint256 underlying,
        uint256 day
    ) internal {
        uint64 day64 = uint64(day);
        require(uint192(underlying) == underlying && day64 == day);
        self.list[day64].underlying = uint192(underlying);
        DelayedRedemptionHeadTail memory headTail = self.headTail;
        require(day64 > headTail.tail);
        if (headTail.tail == 0) {
            // The list was empty.
            headTail.head = day64;
            headTail.tail = day64;
        } else {
            self.list[headTail.tail].next = day64;
            headTail.tail = day64;
        }
        self.headTail = headTail;
    }

    /// @dev Remove all items until a given trading day and return the sum of all items.
    /// @param self The list to update
    /// @param day Trading day
    /// @return Sum of all redemptions that are removed from the list
    function popFrontUntil(DelayedRedemption storage self, uint256 day) internal returns (uint256) {
        uint64 day64 = uint64(day);
        require(day64 == day);
        DelayedRedemptionHeadTail memory headTail = self.headTail;
        uint64 p = headTail.head;
        if (p > day64 || p == 0) {
            return 0; // Fast path with no SSTORE
        }
        uint256 underlying = 0;
        while (p != 0 && p <= day64) {
            underlying = underlying.add(uint256(self.list[p].underlying));
            uint64 nextP = self.list[p].next;
            delete self.list[p];
            p = nextP;
        }
        if (p == 0) {
            delete self.headTail; // Set both head and tail to zero
        } else {
            headTail.head = p;
            self.headTail = headTail;
        }
        return underlying;
    }
}
