// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

library AdvancedMath {
    /// @dev Calculate square root.
    ///
    ///      Reference: https://en.wikipedia.org/wiki/Integer_square_root#Algorithm_using_Newton's_method
    function sqrt(uint256 s) internal pure returns (uint256) {
        if (s == 0) return 0;
        uint256 t = s;
        uint256 x0 = 2;
        if (t >= 1 << 128) {
            t >>= 128;
            x0 <<= 64;
        }
        if (t >= 1 << 64) {
            t >>= 64;
            x0 <<= 32;
        }
        if (t >= 1 << 32) {
            t >>= 32;
            x0 <<= 16;
        }
        if (t >= 1 << 16) {
            t >>= 16;
            x0 <<= 8;
        }
        if (t >= 1 << 8) {
            t >>= 8;
            x0 <<= 4;
        }
        if (t >= 1 << 4) {
            t >>= 4;
            x0 <<= 2;
        }
        if (t >= 1 << 2) {
            x0 <<= 1;
        }
        uint256 x1 = (x0 + s / x0) >> 1;
        while (x1 < x0) {
            x0 = x1;
            x1 = (x0 + s / x0) >> 1;
        }
        return x0;
    }

    /// @notice Calculate cubic root.
    function cbrt(uint256 s) internal pure returns (uint256) {
        if (s == 0) return 0;
        uint256 t = s;
        uint256 x0 = 2;
        if (t >= 1 << 192) {
            t >>= 192;
            x0 <<= 64;
        }
        if (t >= 1 << 96) {
            t >>= 96;
            x0 <<= 32;
        }
        if (t >= 1 << 48) {
            t >>= 48;
            x0 <<= 16;
        }
        if (t >= 1 << 24) {
            t >>= 24;
            x0 <<= 8;
        }
        if (t >= 1 << 12) {
            t >>= 12;
            x0 <<= 4;
        }
        if (t >= 1 << 6) {
            t >>= 6;
            x0 <<= 2;
        }
        if (t >= 1 << 3) {
            x0 <<= 1;
        }
        uint256 x1 = (2 * x0 + s / x0 / x0) / 3;
        while (x1 < x0) {
            x0 = x1;
            x1 = (2 * x0 + s / x0 / x0) / 3;
        }
        return x0;
    }
}
