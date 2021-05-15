// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

/// @notice Amounts of Token M, A and B are sometimes stored in a `uint256[3]` array. This contract
///         defines index of each tranche in this array.
///
///         Solidity does not allow constants to be defined in interfaces. So this contract follows
///         the naming convention of interfaces but is implemented as an `abstract contract`.
abstract contract ITrancheIndex {
    uint256 internal constant TRANCHE_M = 0;
    uint256 internal constant TRANCHE_A = 1;
    uint256 internal constant TRANCHE_B = 2;

    uint256 internal constant TRANCHE_COUNT = 3;
}
