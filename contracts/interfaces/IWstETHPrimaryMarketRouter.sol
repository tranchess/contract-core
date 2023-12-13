// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../interfaces/IFundV5.sol";
import "../interfaces/IStableSwap.sol";

interface IWstETHPrimaryMarketRouter is IStableSwapCore {
    function create(
        address recipient,
        bool isWrapped,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) external returns (uint256 outQ);

    function createAndSplit(
        uint256 underlying,
        bool isWrapped,
        uint256 minOutQ,
        uint256 version
    ) external;
}
