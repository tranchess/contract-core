// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../utils/AdvancedMath.sol";

contract AdvancedMathWrapper {
    using AdvancedMath for uint256;

    function sqrt(uint256 value) external pure returns (uint256) {
        return value.sqrt();
    }

    function cbrt(uint256 value) external pure returns (uint256) {
        return value.cbrt();
    }
}
