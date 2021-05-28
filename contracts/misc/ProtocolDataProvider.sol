// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interfaces/ITrancheIndex.sol";
import "../utils/CoreUtility.sol";

import {UnsettledTrade} from "../exchange/LibUnsettledTrade.sol";
import "../exchange/Exchange.sol";
import "../fund/Fund.sol";
import "../fund/PrimaryMarket.sol";
import "../governance/InterestRateBallot.sol";
import "../governance/VotingEscrow.sol";

interface IExchange {
    function unsettledTrades(
        address account,
        uint256 tranche,
        uint256 epoch
    ) external view returns (UnsettledTrade memory);
}

contract ProtocolDataProvider is ITrancheIndex, CoreUtility {
    struct ProtocolData {
        uint256 blockNumber;
        uint256 blockTimestamp;
        WalletData wallet;
        FundData fund;
        PrimaryMarketData primaryMarket;
        ExchangeData exchange;
        GovernanceData governance;
    }

    struct WalletData {
        WalletBalanceData balance;
        WalletAllowanceData allowance;
    }

    struct WalletBalanceData {
        uint256 underlyingToken;
        uint256 quoteToken;
        uint256 tokenM;
        uint256 tokenA;
        uint256 tokenB;
        uint256 chess;
    }

    struct WalletAllowanceData {
        uint256 primaryMarketUnderlying;
        WalletAllowanceExchangeData exchange;
        uint256 votingEscrowChess;
    }

    struct WalletAllowanceExchangeData {
        uint256 quoteToken;
        uint256 tokenM;
        uint256 tokenA;
        uint256 tokenB;
    }

    struct FundData {
        bool isFundActive;
        bool isPrimaryMarketActive;
        bool isExchangeActive;
        uint256 fundActivityStartTime;
        uint256 exchangeActivityStartTime;
        uint256 currentDay;
        uint256 dailyProtocolFeeRate;
        uint256 totalShares;
        uint256 totalUnderlying;
        uint256 rebalanceSize;
        uint256 currentInterestRate;
    }

    struct PrimaryMarketData {
        uint256 currentCreatingUnderlying;
        uint256 currentRedeemingShares;
        PrimaryMarket.CreationRedemption account;
    }

    struct ExchangeData {
        Shares totalDeposited;
        ExchangeAccountData account;
    }

    struct ExchangeAccountData {
        Shares available;
        Shares locked;
        bool isMaker;
        uint256 chessRewards;
    }

    struct Shares {
        uint256 tokenM;
        uint256 tokenA;
        uint256 tokenB;
    }

    struct GovernanceData {
        uint256 chessTotalSupply;
        VotingEscrowData votingEscrow;
        BallotData interestRateBallot;
    }

    struct VotingEscrowData {
        uint256 chessBalance;
        uint256 totalSupply;
        IVotingEscrow.LockedBalance account;
    }

    struct BallotData {
        uint256 nextCloseTimestamp;
        IBallot.Voter account;
    }

    /// @dev This function should be call as a "view" function off-chain to get the return value,
    ///      e.g. using `contract.getProtocolData.call()` in web3
    ///      or `contract.callStatic["getProtocolData"]()` in ethers.js.
    function getProtocolData(
        address primaryMarketAddress,
        address exchangeAddress,
        address account
    ) external returns (ProtocolData memory data) {
        data.blockNumber = block.number;
        data.blockTimestamp = block.timestamp;

        Exchange exchange = Exchange(exchangeAddress);
        Fund fund = Fund(address(exchange.fund()));
        VotingEscrow votingEscrow = VotingEscrow(address(exchange.votingEscrow()));
        IERC20 underlyingToken = IERC20(fund.tokenUnderlying());
        IERC20 quoteToken = IERC20(exchange.quoteAssetAddress());
        IERC20 chessToken = IERC20(votingEscrow.token());

        data.wallet.balance.underlyingToken = underlyingToken.balanceOf(account);
        data.wallet.balance.quoteToken = quoteToken.balanceOf(account);
        (data.wallet.balance.tokenM, data.wallet.balance.tokenA, data.wallet.balance.tokenB) = fund
            .allShareBalanceOf(account);
        data.wallet.balance.chess = chessToken.balanceOf(account);

        data.wallet.allowance.primaryMarketUnderlying = underlyingToken.allowance(
            account,
            primaryMarketAddress
        );
        data.wallet.allowance.exchange.quoteToken = quoteToken.allowance(account, exchangeAddress);
        data.wallet.allowance.exchange.tokenM = fund.shareAllowance(
            TRANCHE_M,
            account,
            exchangeAddress
        );
        data.wallet.allowance.exchange.tokenA = fund.shareAllowance(
            TRANCHE_A,
            account,
            exchangeAddress
        );
        data.wallet.allowance.exchange.tokenB = fund.shareAllowance(
            TRANCHE_B,
            account,
            exchangeAddress
        );
        data.wallet.allowance.votingEscrowChess = chessToken.allowance(
            account,
            address(votingEscrow)
        );

        data.fund.isFundActive = fund.isFundActive(block.timestamp);
        data.fund.isPrimaryMarketActive = fund.isPrimaryMarketActive(
            primaryMarketAddress,
            block.timestamp
        );
        data.fund.isExchangeActive = fund.isExchangeActive(block.timestamp);
        data.fund.fundActivityStartTime = fund.fundActivityStartTime();
        data.fund.exchangeActivityStartTime = fund.exchangeActivityStartTime();
        data.fund.currentDay = fund.currentDay();
        data.fund.dailyProtocolFeeRate = fund.dailyProtocolFeeRate();
        data.fund.totalShares = fund.getTotalShares();
        data.fund.totalUnderlying = underlyingToken.balanceOf(address(fund));
        data.fund.rebalanceSize = fund.getRebalanceSize();
        data.fund.currentInterestRate = fund.historicalInterestRate(
            _endOfWeek(data.fund.currentDay - 1 days)
        );

        PrimaryMarket primaryMarket = PrimaryMarket(primaryMarketAddress);
        data.primaryMarket.currentCreatingUnderlying = primaryMarket.currentCreatingUnderlying();
        data.primaryMarket.currentRedeemingShares = primaryMarket.currentRedeemingShares();
        data.primaryMarket.account = primaryMarket.creationRedemptionOf(account);

        data.exchange.totalDeposited.tokenM = exchange.totalSupply(TRANCHE_M);
        data.exchange.totalDeposited.tokenA = exchange.totalSupply(TRANCHE_A);
        data.exchange.totalDeposited.tokenB = exchange.totalSupply(TRANCHE_B);
        data.exchange.account.available.tokenM = exchange.availableBalanceOf(TRANCHE_M, account);
        data.exchange.account.available.tokenA = exchange.availableBalanceOf(TRANCHE_A, account);
        data.exchange.account.available.tokenB = exchange.availableBalanceOf(TRANCHE_B, account);
        data.exchange.account.locked.tokenM = exchange.lockedBalanceOf(TRANCHE_M, account);
        data.exchange.account.locked.tokenA = exchange.lockedBalanceOf(TRANCHE_A, account);
        data.exchange.account.locked.tokenB = exchange.lockedBalanceOf(TRANCHE_B, account);
        data.exchange.account.isMaker = exchange.isMaker(account);
        data.exchange.account.chessRewards = exchange.claimableRewards(account);

        data.governance.chessTotalSupply = chessToken.totalSupply();
        data.governance.votingEscrow.chessBalance = chessToken.balanceOf(address(votingEscrow));
        data.governance.votingEscrow.totalSupply = votingEscrow.totalSupply();
        data.governance.votingEscrow.account = votingEscrow.getLockedBalance(account);
        data.governance.interestRateBallot.nextCloseTimestamp = _endOfWeek(
            data.fund.currentDay - 1 days
        );
        data.governance.interestRateBallot.account = InterestRateBallot(address(fund.ballot()))
            .getReceipt(account);
    }

    function getUnsettledTrades(
        address exchangeAddress,
        address account,
        uint256[] memory epochs
    )
        external
        view
        returns (
            UnsettledTrade[] memory unsettledTradeM,
            UnsettledTrade[] memory unsettledTradeA,
            UnsettledTrade[] memory unsettledTradeB
        )
    {
        IExchange exchange = IExchange(exchangeAddress);
        unsettledTradeM = new UnsettledTrade[](epochs.length);
        unsettledTradeA = new UnsettledTrade[](epochs.length);
        unsettledTradeB = new UnsettledTrade[](epochs.length);
        for (uint256 i = 0; i < epochs.length; i++) {
            unsettledTradeM[i] = exchange.unsettledTrades(account, TRANCHE_M, epochs[i]);
            unsettledTradeA[i] = exchange.unsettledTrades(account, TRANCHE_A, epochs[i]);
            unsettledTradeB[i] = exchange.unsettledTrades(account, TRANCHE_B, epochs[i]);
        }
    }
}
