// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

contract CoreUtility {
    using SafeMath for uint256;

    /// @notice UTC time of a day when the fund settles.
    uint256 public constant SETTLEMENT_TIME = 14 hours;

    /// @notice Return end timestamp of the trading week containing a given timestamp.
    /// @param timestamp The given timestamp
    /// @return End timestamp of the trading week.
    function endOfWeek(uint256 timestamp) public pure returns (uint256) {
        return ((timestamp.add(1 weeks) - SETTLEMENT_TIME) / 1 weeks) * 1 weeks + SETTLEMENT_TIME;
    }
}
