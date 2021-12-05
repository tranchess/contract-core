// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "./IPrimaryMarket.sol";

interface IPrimaryMarketV2 is IPrimaryMarket {
    function claimAndUnwrap(address account)
        external
        returns (uint256 createdShares, uint256 redeemedUnderlying);

    function updateDelayedRedemptionDay() external;
}
