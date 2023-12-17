// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IPrimaryMarketV5 {
    function fund() external view returns (address);

    function getCreation(uint256 underlying) external view returns (uint256 outQ);

    function getRedemption(uint256 inQ) external view returns (uint256 underlying, uint256 fee);

    function getSplit(uint256 inQ) external view returns (uint256 outB, uint256 outQ);

    function getMerge(uint256 inB) external view returns (uint256 inR, uint256 outQ, uint256 feeQ);

    function canBeRemovedFromFund() external view returns (bool);

    function create(
        address recipient,
        uint256 minOutQ,
        uint256 version
    ) external returns (uint256 outQ);

    function redeem(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external returns (uint256 underlying);

    function redeemAndUnwrap(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external returns (uint256 underlying);

    function queueRedemption(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external returns (uint256 underlying, uint256 index);

    function claimRedemptions(
        address account,
        uint256[] calldata indices
    ) external returns (uint256 underlying);

    function claimRedemptionsAndUnwrap(
        address account,
        uint256[] calldata indices
    ) external returns (uint256 underlying);

    function split(
        address recipient,
        uint256 inQ,
        uint256 version
    ) external returns (uint256 outB, uint256 outR);

    function merge(address recipient, uint256 inB, uint256 version) external returns (uint256 outQ);

    function settle(uint256 day) external;
}
