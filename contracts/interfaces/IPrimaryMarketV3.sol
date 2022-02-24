// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

interface IPrimaryMarketV3 {
    function create(address recipient, uint256 underlying) external;

    function wrapAndCreate(address recipient) external payable;

    function redeem(address recipient, uint256 shares) external;

    function claim(address account)
        external
        returns (uint256 createdShares, uint256 redeemedUnderlying);

    function claimAndUnwrap(address account)
        external
        returns (uint256 createdShares, uint256 redeemedUnderlying);

    function split(address recipient, uint256 inM) external returns (uint256 outA, uint256 outB);

    function merge(address recipient, uint256 inA) external returns (uint256 inB, uint256 outM);

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
