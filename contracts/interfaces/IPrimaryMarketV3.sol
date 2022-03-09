// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "./IFundV3.sol";

interface IPrimaryMarketV3 {
    function fund() external view returns (IFundV3);

    function getCreation(uint256 underlying) external view returns (uint256 shares);

    function getRedemption(uint256 shares) external view returns (uint256 underlying);

    function getSplit(uint256 inM)
        external
        view
        returns (
            uint256 outA,
            uint256 outB,
            uint256 feeM
        );

    function getTokenAMForSplitB(uint256 outB) external view returns (uint256 outA, uint256 inM);

    function getMerge(uint256 expectA)
        external
        view
        returns (
            uint256 inA,
            uint256 inB,
            uint256 outM,
            uint256 feeM
        );

    function getTokenAMForMergeB(uint256 inB) external view returns (uint256 inA, uint256 outM);

    function create(
        address recipient,
        uint256 underlying,
        uint256 minShares,
        uint256 version
    ) external returns (uint256 shares);

    function wrapAndCreate(
        address recipient,
        uint256 minShares,
        uint256 version
    ) external payable returns (uint256 shares);

    function redeem(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external returns (uint256 underlying);

    function redeemAndUnwrap(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external returns (uint256 underlying);

    function delayRedeem(
        address recipient,
        uint256 shares,
        uint256 version
    ) external;

    function claim(address account) external returns (uint256 redeemedUnderlying);

    function claimAndUnwrap(address account) external returns (uint256 redeemedUnderlying);

    function split(
        address recipient,
        uint256 inM,
        uint256 version
    ) external returns (uint256 outA, uint256 outB);

    function merge(
        address recipient,
        uint256 inA,
        uint256 version
    ) external returns (uint256 inB, uint256 outM);

    function settle(
        uint256 day,
        uint256 fundTotalShares,
        uint256 fundUnderlying,
        uint256 underlyingPrice,
        uint256 previousNav
    )
        external
        returns (
            uint256 sharesToMint,
            uint256 sharesToBurn,
            uint256 creationUnderlying,
            uint256 redemptionUnderlying,
            uint256 fee
        );

    function updateDelayedRedemptionDay() external;
}
