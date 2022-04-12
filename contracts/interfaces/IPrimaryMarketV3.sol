// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "./IFundV3.sol";

interface IPrimaryMarketV3 {
    function fund() external view returns (IFundV3);

    function getCreation(uint256 underlying) external view returns (uint256 shares);

    function getCreationForShares(uint256 minShares) external view returns (uint256 underlying);

    function getRedemption(uint256 shares) external view returns (uint256 underlying, uint256 fee);

    function getRedemptionForUnderlying(uint256 minUnderlying)
        external
        view
        returns (uint256 shares);

    function getSplit(uint256 inM) external view returns (uint256 outAB);

    function getSplitForAB(uint256 minOutAB) external view returns (uint256 inM);

    function getMerge(uint256 inAB) external view returns (uint256 outM, uint256 feeM);

    function getMergeForM(uint256 minOutM) external view returns (uint256 inAB);

    function canBeRemovedFromFund() external view returns (bool);

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

    function queueRedemption(
        address recipient,
        uint256 shares,
        uint256 minUnderlying,
        uint256 version
    ) external returns (uint256 underlying, uint256 index);

    function claimRedemptions(address account, uint256[] calldata indices)
        external
        returns (uint256 underlying);

    function claimRedemptionsAndUnwrap(address account, uint256[] calldata indices)
        external
        returns (uint256 underlying);

    function split(
        address recipient,
        uint256 inM,
        uint256 version
    ) external returns (uint256 outAB);

    function merge(
        address recipient,
        uint256 inAB,
        uint256 version
    ) external returns (uint256 outM);

    function settle(uint256 day) external;
}
