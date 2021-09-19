// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interfaces/ITrancheIndex.sol";
import "../interfaces/IChessSchedule.sol";
import "../utils/CoreUtility.sol";

import {UnsettledTrade} from "../exchange/LibUnsettledTrade.sol";
import {VESnapshot} from "../exchange/StakingV2.sol";
import "../exchange/ExchangeV2.sol";
import "../fund/Fund.sol";
import "../fund/PrimaryMarket.sol";
import "../governance/InterestRateBallot.sol";
import "../governance/VotingEscrow.sol";

interface IExchange {
    function chessSchedule() external view returns (IChessSchedule);

    function unsettledTrades(
        address account,
        uint256 tranche,
        uint256 epoch
    ) external view returns (UnsettledTrade memory);
}

interface IFeeDistributor {
    function rewardsPerWeek(uint256 timestamp) external view returns (uint256);

    function veSupplyPerWeek(uint256 timestamp) external view returns (uint256);

    function totalSupplyAtTimestamp(uint256 timestamp) external view returns (uint256);

    function userLastBalances(address account) external view returns (uint256);

    function userLockedBalances(address account)
        external
        view
        returns (IVotingEscrow.LockedBalance memory);

    function userCheckpoint(address account) external returns (uint256 rewards);
}

interface IPancakePair {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        );
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
        SwapPairData pair;
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
        uint256 currentWeek;
        uint256 dailyProtocolFeeRate;
        uint256 totalShares;
        uint256 totalUnderlying;
        uint256 rebalanceSize;
        uint256 currentInterestRate;
        Fund.Rebalance lastRebalance;
    }

    struct PrimaryMarketData {
        uint256 currentCreatingUnderlying;
        uint256 currentRedeemingShares;
        PrimaryMarket.CreationRedemption account;
    }

    struct ExchangeData {
        Shares totalDeposited;
        uint256 weightedSupply;
        uint256 workingSupply;
        ExchangeAccountData account;
    }

    struct ExchangeAccountData {
        Shares available;
        Shares locked;
        uint256 weightedBalance;
        uint256 workingBalance;
        VESnapshot veSnapshot;
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
        uint256 chessRate;
        VotingEscrowData votingEscrow;
        BallotData interestRateBallot;
        FeeDistributorData feeDistributor;
    }

    struct VotingEscrowData {
        uint256 chessBalance;
        uint256 totalSupply;
        uint256 tradingWeekTotalSupply;
        IVotingEscrow.LockedBalance account;
    }

    struct BallotData {
        uint256 tradingWeekTotalSupply;
        IBallot.Voter account;
    }

    struct FeeDistributorData {
        FeeDistributorAccountData account;
        uint256 currentRewards;
        uint256 currentSupply;
        uint256 tradingWeekTotalSupply;
        HistoricalRewardData[3] historicalRewards;
    }

    struct HistoricalRewardData {
        uint256 timestamp;
        uint256 veSupply;
        uint256 rewards;
    }

    struct FeeDistributorAccountData {
        uint256 claimableRewards;
        uint256 currentBalance;
        uint256 amount;
        uint256 unlockTime;
    }

    struct SwapPairData {
        uint112 reserve0;
        uint112 reserve1;
        address token0;
        address token1;
    }

    /// @dev This function should be call as a "view" function off-chain to get the return value,
    ///      e.g. using `contract.getProtocolData.call()` in web3
    ///      or `contract.callStatic["getProtocolData"]()` in ethers.js.
    function getProtocolData(
        address primaryMarketAddress,
        address exchangeAddress,
        address pancakePairAddress,
        address feeDistributorAddress,
        address account
    ) external returns (ProtocolData memory data) {
        data.blockNumber = block.number;
        data.blockTimestamp = block.timestamp;

        ExchangeV2 exchange = ExchangeV2(exchangeAddress);
        Fund fund = Fund(address(exchange.fund()));
        VotingEscrow votingEscrow =
            VotingEscrow(address(InterestRateBallot(address(fund.ballot())).votingEscrow()));
        IERC20 underlyingToken = IERC20(fund.tokenUnderlying());
        IERC20 quoteToken = IERC20(exchange.quoteAssetAddress());
        IERC20 chessToken = IERC20(votingEscrow.token());
        IChessSchedule chessSchedule = exchange.chessSchedule();

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
        data.fund.currentWeek = _endOfWeek(data.fund.currentDay - 1 days);
        data.fund.dailyProtocolFeeRate = fund.dailyProtocolFeeRate();
        data.fund.totalShares = fund.getTotalShares();
        data.fund.totalUnderlying = underlyingToken.balanceOf(address(fund));
        data.fund.rebalanceSize = fund.getRebalanceSize();
        data.fund.currentInterestRate = fund.historicalInterestRate(data.fund.currentWeek);
        uint256 rebalanceSize = fund.getRebalanceSize();
        data.fund.lastRebalance = fund.getRebalance(rebalanceSize == 0 ? 0 : rebalanceSize - 1);

        PrimaryMarket primaryMarket = PrimaryMarket(primaryMarketAddress);
        data.primaryMarket.currentCreatingUnderlying = primaryMarket.currentCreatingUnderlying();
        data.primaryMarket.currentRedeemingShares = primaryMarket.currentRedeemingShares();
        data.primaryMarket.account = primaryMarket.creationRedemptionOf(account);

        data.exchange.totalDeposited.tokenM = exchange.totalSupply(TRANCHE_M);
        data.exchange.totalDeposited.tokenA = exchange.totalSupply(TRANCHE_A);
        data.exchange.totalDeposited.tokenB = exchange.totalSupply(TRANCHE_B);
        data.exchange.weightedSupply = exchange.weightedBalance(
            data.exchange.totalDeposited.tokenM,
            data.exchange.totalDeposited.tokenA,
            data.exchange.totalDeposited.tokenB
        );
        data.exchange.workingSupply = exchange.workingSupply();
        data.exchange.account.available.tokenM = exchange.availableBalanceOf(TRANCHE_M, account);
        data.exchange.account.available.tokenA = exchange.availableBalanceOf(TRANCHE_A, account);
        data.exchange.account.available.tokenB = exchange.availableBalanceOf(TRANCHE_B, account);
        data.exchange.account.locked.tokenM = exchange.lockedBalanceOf(TRANCHE_M, account);
        data.exchange.account.locked.tokenA = exchange.lockedBalanceOf(TRANCHE_A, account);
        data.exchange.account.locked.tokenB = exchange.lockedBalanceOf(TRANCHE_B, account);
        data.exchange.account.weightedBalance = exchange.weightedBalance(
            data.exchange.account.available.tokenM + data.exchange.account.locked.tokenM,
            data.exchange.account.available.tokenA + data.exchange.account.locked.tokenA,
            data.exchange.account.available.tokenB + data.exchange.account.locked.tokenB
        );
        data.exchange.account.workingBalance = exchange.workingBalanceOf(account);
        data.exchange.account.veSnapshot = exchange.veSnapshotOf(account);
        data.exchange.account.isMaker = exchange.isMaker(account);
        data.exchange.account.chessRewards = exchange.claimableRewards(account);

        uint256 blockCurrentWeek = _endOfWeek(block.timestamp);
        data.governance.chessTotalSupply = chessToken.totalSupply();
        data.governance.chessRate = chessSchedule.getRate(block.timestamp);
        data.governance.votingEscrow.chessBalance = chessToken.balanceOf(address(votingEscrow));
        data.governance.votingEscrow.totalSupply = votingEscrow.totalSupply();
        data.governance.votingEscrow.tradingWeekTotalSupply = votingEscrow.totalSupplyAtTimestamp(
            blockCurrentWeek
        );
        data.governance.votingEscrow.account = votingEscrow.getLockedBalance(account);
        data.governance.interestRateBallot.tradingWeekTotalSupply = InterestRateBallot(
            address(fund.ballot())
        )
            .totalSupplyAtTimestamp(blockCurrentWeek);
        data.governance.interestRateBallot.account = InterestRateBallot(address(fund.ballot()))
            .getReceipt(account);

        if (feeDistributorAddress != address(0)) {
            IFeeDistributor feeDistributor = IFeeDistributor(feeDistributorAddress);
            data.governance.feeDistributor.account.claimableRewards = feeDistributor.userCheckpoint(
                account
            );
            data.governance.feeDistributor.account.currentBalance = feeDistributor.userLastBalances(
                account
            );
            data.governance.feeDistributor.account.amount = feeDistributor
                .userLockedBalances(account)
                .amount;
            data.governance.feeDistributor.account.unlockTime = feeDistributor
                .userLockedBalances(account)
                .unlockTime;
            data.governance.feeDistributor.currentRewards = feeDistributor.rewardsPerWeek(
                blockCurrentWeek - 1 weeks
            );
            data.governance.feeDistributor.currentSupply = feeDistributor.veSupplyPerWeek(
                blockCurrentWeek - 1 weeks
            );
            data.governance.feeDistributor.tradingWeekTotalSupply = feeDistributor
                .totalSupplyAtTimestamp(blockCurrentWeek);
            for (uint256 i = 0; i < 3; i++) {
                uint256 weekEnd = blockCurrentWeek - (i + 1) * 1 weeks;
                data.governance.feeDistributor.historicalRewards[i].timestamp = weekEnd;
                data.governance.feeDistributor.historicalRewards[i].veSupply = feeDistributor
                    .veSupplyPerWeek(weekEnd - 1 weeks);
                data.governance.feeDistributor.historicalRewards[i].rewards = feeDistributor
                    .rewardsPerWeek(weekEnd - 1 weeks);
            }
        }

        IPancakePair pair = IPancakePair(pancakePairAddress);
        data.pair.token0 = pair.token0();
        data.pair.token1 = pair.token1();
        (data.pair.reserve0, data.pair.reserve1, ) = pair.getReserves();
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
