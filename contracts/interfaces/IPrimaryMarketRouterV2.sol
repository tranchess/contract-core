// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../interfaces/IFundV3.sol";
import "../interfaces/IStableSwap.sol";

interface IPrimaryMarketRouterV2 is IStableSwapCore {
    function create(
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) external payable returns (uint256 outQ);

    function createAndSplit(
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) external payable returns (uint256 outB, uint256 outR);
}
