// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

abstract contract CoreUtility {
    using SafeMath for uint256;

    /// @dev UTC time of a day when the fund settles.
    uint256 internal constant SETTLEMENT_TIME = 14 hours;

    /// @dev Return end timestamp of the trading week containing a given timestamp.
    ///
    ///      A trading week starts at UTC time `SETTLEMENT_TIME` on a Thursday (inclusive)
    ///      and ends at the same time of the next Thursday (exclusive).
    /// @param timestamp The given timestamp
    /// @return End timestamp of the trading week.
    function _endOfWeek(uint256 timestamp) internal pure returns (uint256) {
        return ((timestamp.add(1 weeks) - SETTLEMENT_TIME) / 1 weeks) * 1 weeks + SETTLEMENT_TIME;
    }
}
