// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../interfaces/IFundV3.sol";
import "../interfaces/IStableSwap.sol";

interface IPrimaryMarketRouter is IStableSwapCore {
    function create(
        uint256 underlying,
        address recipient,
        uint256 minOutQ,
        uint256 version
    ) external returns (uint256 outQ);

    function createAndStake(
        uint256 underlying,
        uint256 minOutQ,
        address staking,
        uint256 version
    ) external;

    function createAndStake(
        address router,
        address quoteAddress,
        uint256 underlying,
        uint256 minOutQ,
        address staking,
        uint256 version
    ) external;
}
