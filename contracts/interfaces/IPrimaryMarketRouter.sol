// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../interfaces/IFundV3.sol";
import "../interfaces/IStableSwap.sol";

interface IPrimaryMarketRouter is IStableSwapCore {
    function create(
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) external payable returns (uint256 outQ);

    function createAndStake(
        uint256 underlying,
        uint256 minOutQ,
        address staking,
        uint256 version
    ) external payable;

    function createSplitAndStake(
        uint256 underlying,
        uint256 minOutQ,
        address router,
        address quoteAddress,
        uint256 minLpOut,
        address staking,
        uint256 version
    ) external payable;

    function splitAndStake(
        uint256 inQ,
        address router,
        address quoteAddress,
        uint256 minLpOut,
        address staking,
        uint256 version
    ) external;
}
