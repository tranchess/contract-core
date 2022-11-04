// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/SafeDecimalMath.sol";
import "../interfaces/IFundV3.sol";

/// @title Queen Rate Provider
/// @notice Returns the value of Queen in terms of the underlying
contract QueenRateProvider {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    IFundV3 public immutable fund;
    /// @dev A multipler that normalizes a underlying asset balance to 18 decimal places.
    uint256 internal immutable _underlyingDecimalMultiplier;

    constructor(address fund_) public {
        fund = IFundV3(fund_);
        _underlyingDecimalMultiplier = IFundV3(fund_).underlyingDecimalMultiplier();
    }

    /// @return the value of Queen in terms of the underlying
    function getRate() external view returns (uint256) {
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundEquivalentTotalQ = fund.getEquivalentTotalQ();
        return fundUnderlying.mul(_underlyingDecimalMultiplier).divideDecimal(fundEquivalentTotalQ);
    }
}
