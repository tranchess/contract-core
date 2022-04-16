// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../interfaces/ISwapRouter.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/IPrimaryMarketV3.sol";
import "../exchange/StakingV4.sol";
import "../interfaces/IWrappedERC20.sol";

/// @title Tranchess Queen Swap Router
/// @notice Router for stateless execution of Queen exchange
contract QueenSwapRouter is ITrancheIndexV2 {
    using SafeERC20 for IERC20;

    /// @notice Receive unwrapped transfer from the wrapped token.
    receive() external payable {}

    function create(
        address primaryMarket,
        address swapRouter,
        uint256 version,
        uint256 underlying,
        uint256 minOutQ,
        address recipient,
        address staking
    ) external payable returns (uint256 outQ) {
        IPrimaryMarketV3 pm = IPrimaryMarketV3(primaryMarket);
        IFundV3 fund = IPrimaryMarketV3(primaryMarket).fund();
        // Wrap token and retain underlying payment
        IWrappedERC20(fund.tokenUnderlying()).deposit{value: msg.value}();
        IERC20(fund.tokenUnderlying()).safeTransferFrom(msg.sender, address(this), underlying);
        underlying += msg.value;
        // Get out amount from swap
        address[] memory path = new address[](2);
        path[0] = fund.tokenUnderlying();
        path[1] = fund.tokenQ();
        uint256 swapAmount = ISwapRouter(swapRouter).getAmountsOut(underlying, path)[1];
        // Get out amount from primary market
        uint256 pmAmount = pm.getCreation(underlying);

        if (pmAmount < swapAmount) {
            // Swap path
            IERC20(path[0]).safeApprove(swapRouter, underlying);
            uint256[] memory versions = new uint256[](1);
            versions[0] = version;
            outQ = ISwapRouter(swapRouter).swapExactTokensForTokens(
                underlying,
                minOutQ,
                path,
                recipient,
                staking,
                versions,
                block.timestamp
            )[1];
        } else {
            // Primary market path
            IERC20(path[0]).safeApprove(address(pm), underlying);
            if (staking != address(0)) {
                outQ = pm.create(address(this), underlying, minOutQ, version);
                IERC20(path[1]).safeApprove(staking, outQ);
                StakingV4(staking).deposit(TRANCHE_Q, outQ, recipient, version);
            } else {
                outQ = pm.create(recipient, underlying, minOutQ, version);
            }
        }
    }

    function redeem(
        address primaryMarket,
        address swapRouter,
        uint256 version,
        uint256 inQ,
        uint256 minUnderlying,
        address recipient
    ) external returns (uint256 underlying) {
        IPrimaryMarketV3 pm = IPrimaryMarketV3(primaryMarket);
        IFundV3 fund = pm.fund();
        // Get out amount from swap
        address[] memory path = new address[](2);
        path[0] = fund.tokenQ();
        path[1] = fund.tokenUnderlying();
        uint256 swapAmount = ISwapRouter(swapRouter).getAmountsOut(inQ, path)[1];
        // Get out amount from primary market
        (uint256 pmAmount, ) = pm.getRedemption(inQ);
        // Retain queen payment
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), inQ);
        if (pmAmount < swapAmount) {
            // Swap path
            IERC20(path[0]).safeApprove(swapRouter, inQ);
            uint256[] memory versions = new uint256[](1);
            versions[0] = version;
            underlying = ISwapRouter(swapRouter).swapExactTokensForTokens(
                inQ,
                minUnderlying,
                path,
                recipient,
                address(0),
                versions,
                block.timestamp
            )[1];
        } else {
            // Primary market path
            underlying = pm.redeem(recipient, inQ, minUnderlying, version);
        }
    }
}
