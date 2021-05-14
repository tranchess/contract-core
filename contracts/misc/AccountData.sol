// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PendingTrade} from "../exchange/LibPendingTrade.sol";
import "../interfaces/IFund.sol";
import "../interfaces/ITrancheIndex.sol";

interface IExchange {
    function isMaker(address account) external view returns (bool);

    function makerExpiration(address account) external view returns (uint256);

    function availableBalanceOf(uint256 tranche, address account) external view returns (uint256);

    function lockedBalanceOf(uint256 tranche, address account) external view returns (uint256);

    function pendingTrades(
        address account,
        uint256 tranche,
        uint256 epoch
    ) external view returns (PendingTrade memory);

    function totalSupply(uint256 tranche) external view returns (uint256);

    function claimableRewards(address account) external returns (uint256);
}

contract AccountData is ITrancheIndex {
    struct Shares {
        uint256 p;
        uint256 a;
        uint256 b;
    }

    struct ExchangeData {
        Shares available;
        Shares locked;
        bool isMaker;
        uint256 makerExpiration;
        uint256 reward;
    }

    struct AccountDetails {
        Shares circulating;
        uint256 underlying;
        uint256 quote;
        uint256 chess;
    }

    /// @dev This function should be call as a "view" function off-chain to get the return value,
    ///      e.g. using `contract.getAccountExchangeData.call(exchangeAddress, account)` in web3
    ///      or `contract.callStatic["getAccountExchangeData"](exchangeAddress, account)` in ethers.js.
    function getAccountExchangeData(address exchangeAddress, address account)
        external
        returns (ExchangeData memory exchangeData)
    {
        IExchange exchange = IExchange(exchangeAddress);
        exchangeData.available.p = exchange.availableBalanceOf(TRANCHE_P, account);
        exchangeData.available.a = exchange.availableBalanceOf(TRANCHE_A, account);
        exchangeData.available.b = exchange.availableBalanceOf(TRANCHE_B, account);
        exchangeData.locked.p = exchange.lockedBalanceOf(TRANCHE_P, account);
        exchangeData.locked.a = exchange.lockedBalanceOf(TRANCHE_A, account);
        exchangeData.locked.b = exchange.lockedBalanceOf(TRANCHE_B, account);
        exchangeData.isMaker = exchange.isMaker(account);
        exchangeData.makerExpiration = exchange.makerExpiration(account);
        exchangeData.reward = exchange.claimableRewards(account);
    }

    function getAccountDetails(
        address fund,
        address quoteAssetAddress,
        address chess,
        address account
    ) external view returns (AccountDetails memory accountDetails) {
        (
            accountDetails.circulating.p,
            accountDetails.circulating.a,
            accountDetails.circulating.b
        ) = IFund(fund).allShareBalanceOf(account);

        accountDetails.underlying = IERC20(IFund(fund).tokenUnderlying()).balanceOf(account);
        accountDetails.quote = IERC20(quoteAssetAddress).balanceOf(account);
        accountDetails.chess = IERC20(chess).balanceOf(account);
    }

    function getTotalDeposits(address exchangeAddress)
        external
        view
        returns (
            uint256 totalDepositedP,
            uint256 totalDepositedA,
            uint256 totalDepositedB
        )
    {
        IExchange exchange = IExchange(exchangeAddress);
        totalDepositedP = exchange.totalSupply(TRANCHE_P);
        totalDepositedA = exchange.totalSupply(TRANCHE_A);
        totalDepositedB = exchange.totalSupply(TRANCHE_B);
    }

    function getPendingTrades(
        address exchangeAddress,
        address account,
        uint256[] memory epochs
    )
        external
        view
        returns (
            PendingTrade[] memory pendingTradeP,
            PendingTrade[] memory pendingTradeA,
            PendingTrade[] memory pendingTradeB
        )
    {
        IExchange exchange = IExchange(exchangeAddress);
        pendingTradeP = new PendingTrade[](epochs.length);
        pendingTradeA = new PendingTrade[](epochs.length);
        pendingTradeB = new PendingTrade[](epochs.length);
        for (uint256 i = 0; i < epochs.length; i++) {
            pendingTradeP[i] = exchange.pendingTrades(account, TRANCHE_P, epochs[i]);
            pendingTradeA[i] = exchange.pendingTrades(account, TRANCHE_A, epochs[i]);
            pendingTradeB[i] = exchange.pendingTrades(account, TRANCHE_B, epochs[i]);
        }
    }
}
