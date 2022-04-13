// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";

import "../interfaces/ITrancheIndex.sol";
import "../../interfaces/IChessSchedule.sol";
import "../../utils/CoreUtility.sol";

import {UnsettledTrade} from "../exchange/LibUnsettledTrade.sol";
import {VESnapshot} from "../exchange/StakingV2.sol";
import "../exchange/ExchangeV2.sol";
import "../fund/Fund.sol";
import "../fund/FundV2.sol";
import "../fund/PrimaryMarket.sol";
import "../fund/PrimaryMarketV2.sol";
import "../../governance/InterestRateBallot.sol";
import "../../governance/FeeDistributor.sol";
import "../../governance/VotingEscrowV2.sol";
import "../governance/ChessControllerV4.sol";
import "../../governance/ControllerBallot.sol";

interface IExchange {
    function chessSchedule() external view returns (IChessSchedule);

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
        SwapPairData pair;
    }

    struct WalletData {
        WalletBalanceData balance;
        WalletAllowanceData allowance;
    }

    struct WalletBalanceData {
        uint256 nativeCurrency;
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
        uint256 relativeWeight;
        uint256 strategyUnderlying;
    }

    struct PrimaryMarketData {
        uint256 currentCreatingUnderlying;
        uint256 currentRedeemingShares;
        uint256 fundCap;
        uint256 redemptionFeeRate;
        uint256 splitFeeRate;
        uint256 mergeFeeRate;
        uint256 minCreationUnderlying;
        PrimaryMarketAccountData account;
    }

    struct PrimaryMarketAccountData {
        uint256 creatingUnderlying;
        uint256 redeemingShares;
        uint256 createdShares;
        uint256 redeemedUnderlying;
        uint256[16] recentDelayedRedemptions;
    }

    struct ExchangeData {
        Shares totalDeposited;
        uint256 weightedSupply;
        uint256 workingSupply;
        uint256 minBidAmount;
        uint256 minAskAmount;
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
        uint256 nextWeekChessRate;
        VotingEscrowData votingEscrow;
        BallotData interestRateBallot;
        ControllerBallotData controllerBallot;
        FeeDistributorData feeDistributor;
    }

    struct VotingEscrowData {
        uint256 totalLocked;
        uint256 totalSupply;
        uint256 tradingWeekTotalSupply;
        IVotingEscrow.LockedBalance account;
    }

    struct BallotData {
        uint256 tradingWeekTotalSupply;
        IBallot.Voter account;
    }

    struct ControllerBallotData {
        address[] pools;
        uint256[] currentSums;
        ControllerBallotAccountData account;
    }

    struct ControllerBallotAccountData {
        uint256 amount;
        uint256 unlockTime;
        uint256[] weights;
    }

    struct FeeDistributorData {
        FeeDistributorAccountData account;
        uint256 currentRewards;
        uint256 currentSupply;
        uint256 tradingWeekTotalSupply;
        uint256 adminFeeRate;
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

    string public constant VERSION = "1.2.1";

    /// @dev This function should be call as a "view" function off-chain to get the return value,
    ///      e.g. using `contract.getProtocolData.call()` in web3
    ///      or `contract.callStatic.getProtocolData()` in ethers.js.
    function getProtocolData(
        address primaryMarket,
        address exchange,
        address swapPair,
        address feeDistributor,
        address account,
        uint256 fundVersion
    ) external returns (ProtocolData memory data) {
        data.blockNumber = block.number;
        data.blockTimestamp = block.timestamp;

        data.wallet = getWalletData(primaryMarket, exchange, account);

        data.fund = getFundData(primaryMarket, exchange, fundVersion);

        data.primaryMarket = getPrimaryMarketData(primaryMarket, account, fundVersion);

        data.exchange = getExchangeData(exchange, account);

        data.governance = getGovernanceData(exchange, feeDistributor, account);

        data.pair = getSwapPairData(swapPair);
    }

    function getWalletData(
        address primaryMarket,
        address exchange,
        address account
    ) public view returns (WalletData memory data) {
        Fund fund = Fund(address(ExchangeV2(exchange).fund()));
        VotingEscrowV2 votingEscrow =
            VotingEscrowV2(address(InterestRateBallot(address(fund.ballot())).votingEscrow()));
        IERC20 underlyingToken = IERC20(fund.tokenUnderlying());
        IERC20 quoteToken = IERC20(ExchangeV2(exchange).quoteAssetAddress());
        IERC20 chessToken = IERC20(votingEscrow.token());

        data.balance.nativeCurrency = account.balance;
        data.balance.underlyingToken = underlyingToken.balanceOf(account);
        data.balance.quoteToken = quoteToken.balanceOf(account);
        (data.balance.tokenM, data.balance.tokenA, data.balance.tokenB) = fund.allShareBalanceOf(
            account
        );
        data.balance.chess = chessToken.balanceOf(account);

        data.allowance.primaryMarketUnderlying = underlyingToken.allowance(account, primaryMarket);
        data.allowance.exchange.quoteToken = quoteToken.allowance(account, exchange);
        data.allowance.exchange.tokenM = fund.shareAllowance(TRANCHE_M, account, exchange);
        data.allowance.exchange.tokenA = fund.shareAllowance(TRANCHE_A, account, exchange);
        data.allowance.exchange.tokenB = fund.shareAllowance(TRANCHE_B, account, exchange);
        data.allowance.votingEscrowChess = chessToken.allowance(account, address(votingEscrow));
    }

    function getFundData(
        address primaryMarket,
        address exchange,
        uint256 fundVersion
    ) public returns (FundData memory data) {
        Fund fund = Fund(address(ExchangeV2(exchange).fund()));
        data.isFundActive = fund.isFundActive(block.timestamp);
        data.isPrimaryMarketActive = fund.isPrimaryMarketActive(primaryMarket, block.timestamp);
        data.isExchangeActive = fund.isExchangeActive(block.timestamp);
        data.fundActivityStartTime = fund.fundActivityStartTime();
        data.exchangeActivityStartTime = fund.exchangeActivityStartTime();
        data.currentDay = fund.currentDay();
        data.currentWeek = _endOfWeek(data.currentDay - 1 days);
        data.dailyProtocolFeeRate = fund.dailyProtocolFeeRate();
        data.totalShares = fund.getTotalShares();
        data.rebalanceSize = fund.getRebalanceSize();
        data.currentInterestRate = fund.historicalInterestRate(data.currentWeek);
        uint256 rebalanceSize = fund.getRebalanceSize();
        data.lastRebalance = fund.getRebalance(rebalanceSize == 0 ? 0 : rebalanceSize - 1);
        ExchangeV2(exchange).refreshBalance(address(0), 0); // Trigger checkpoint
        data.relativeWeight = ExchangeV2(exchange).chessController().getFundRelativeWeight(
            address(fund),
            block.timestamp
        );
        if (fundVersion < 2) {
            IERC20 underlyingToken = IERC20(fund.tokenUnderlying());
            data.totalUnderlying = underlyingToken.balanceOf(address(fund));
        } else {
            data.totalUnderlying = FundV2(address(fund)).getTotalUnderlying();
            data.strategyUnderlying = FundV2(address(fund)).getStrategyUnderlying();
        }
    }

    function getPrimaryMarketData(
        address primaryMarket,
        address account,
        uint256 fundVersion
    ) public returns (PrimaryMarketData memory data) {
        PrimaryMarketV2 primaryMarket_ = PrimaryMarketV2(payable(primaryMarket));
        data.currentCreatingUnderlying = primaryMarket_.currentCreatingUnderlying();
        data.currentRedeemingShares = primaryMarket_.currentRedeemingShares();
        data.redemptionFeeRate = primaryMarket_.redemptionFeeRate();
        data.splitFeeRate = primaryMarket_.splitFeeRate();
        data.mergeFeeRate = primaryMarket_.mergeFeeRate();
        data.minCreationUnderlying = primaryMarket_.minCreationUnderlying();
        PrimaryMarketV2.CreationRedemption memory cr = primaryMarket_.creationRedemptionOf(account);
        data.account.creatingUnderlying = cr.creatingUnderlying;
        data.account.redeemingShares = cr.redeemingShares;
        data.account.createdShares = cr.createdShares;
        data.account.redeemedUnderlying = cr.redeemedUnderlying;
        if (fundVersion >= 2) {
            data.fundCap = primaryMarket_.fundCap();
            uint256 currentDay = primaryMarket_.currentDay();
            for (uint256 i = 0; i < 16; i++) {
                (data.account.recentDelayedRedemptions[i], ) = primaryMarket_.getDelayedRedemption(
                    account,
                    currentDay - (i + 1) * 1 days
                );
            }
        }
    }

    function getExchangeData(address exchange, address account)
        public
        returns (ExchangeData memory data)
    {
        ExchangeV2 exchangeContract = ExchangeV2(exchange);
        data.totalDeposited.tokenM = exchangeContract.totalSupply(TRANCHE_M);
        data.totalDeposited.tokenA = exchangeContract.totalSupply(TRANCHE_A);
        data.totalDeposited.tokenB = exchangeContract.totalSupply(TRANCHE_B);
        data.weightedSupply = exchangeContract.weightedBalance(
            data.totalDeposited.tokenM,
            data.totalDeposited.tokenA,
            data.totalDeposited.tokenB
        );
        data.workingSupply = exchangeContract.workingSupply();
        data.minBidAmount = exchangeContract.minBidAmount();
        data.minAskAmount = exchangeContract.minAskAmount();
        data.account.available.tokenM = exchangeContract.availableBalanceOf(TRANCHE_M, account);
        data.account.available.tokenA = exchangeContract.availableBalanceOf(TRANCHE_A, account);
        data.account.available.tokenB = exchangeContract.availableBalanceOf(TRANCHE_B, account);
        data.account.locked.tokenM = exchangeContract.lockedBalanceOf(TRANCHE_M, account);
        data.account.locked.tokenA = exchangeContract.lockedBalanceOf(TRANCHE_A, account);
        data.account.locked.tokenB = exchangeContract.lockedBalanceOf(TRANCHE_B, account);
        data.account.weightedBalance = exchangeContract.weightedBalance(
            data.account.available.tokenM + data.account.locked.tokenM,
            data.account.available.tokenA + data.account.locked.tokenA,
            data.account.available.tokenB + data.account.locked.tokenB
        );
        data.account.workingBalance = exchangeContract.workingBalanceOf(account);
        data.account.veSnapshot = exchangeContract.veSnapshotOf(account);
        data.account.isMaker = exchangeContract.isMaker(account);
        data.account.chessRewards = exchangeContract.claimableRewards(account);
    }

    function getGovernanceData(
        address exchange,
        address feeDistributor,
        address account
    ) public returns (GovernanceData memory data) {
        Fund fund = Fund(address(ExchangeV2(exchange).fund()));
        VotingEscrowV2 votingEscrow =
            VotingEscrowV2(address(InterestRateBallot(address(fund.ballot())).votingEscrow()));
        IERC20 chessToken = IERC20(votingEscrow.token());
        IChessSchedule chessSchedule = ExchangeV2(exchange).chessSchedule();

        uint256 blockCurrentWeek = _endOfWeek(block.timestamp);
        data.chessTotalSupply = chessToken.totalSupply();
        data.chessRate = chessSchedule.getRate(block.timestamp);
        data.nextWeekChessRate = chessSchedule.getRate(block.timestamp + 7 days);
        data.votingEscrow.totalLocked = votingEscrow.totalLocked();
        data.votingEscrow.totalSupply = votingEscrow.totalSupply();
        data.votingEscrow.tradingWeekTotalSupply = votingEscrow.totalSupplyAtTimestamp(
            blockCurrentWeek
        );
        data.votingEscrow.account = votingEscrow.getLockedBalance(account);
        data.interestRateBallot.tradingWeekTotalSupply = InterestRateBallot(address(fund.ballot()))
            .totalSupplyAtTimestamp(blockCurrentWeek);
        data.interestRateBallot.account = InterestRateBallot(address(fund.ballot())).getReceipt(
            account
        );

        data.controllerBallot = getControllerBallotData(exchange, account);

        if (feeDistributor != address(0)) {
            FeeDistributor feeDistributor_ = FeeDistributor(payable(feeDistributor));
            data.feeDistributor.account.claimableRewards = feeDistributor_.userCheckpoint(account);
            data.feeDistributor.account.currentBalance = feeDistributor_.userLastBalances(account);
            (
                data.feeDistributor.account.amount,
                data.feeDistributor.account.unlockTime
            ) = feeDistributor_.userLockedBalances(account);
            data.feeDistributor.currentRewards = feeDistributor_.rewardsPerWeek(
                blockCurrentWeek - 1 weeks
            );
            data.feeDistributor.currentSupply = feeDistributor_.veSupplyPerWeek(
                blockCurrentWeek - 1 weeks
            );
            data.feeDistributor.tradingWeekTotalSupply = feeDistributor_.totalSupplyAtTimestamp(
                blockCurrentWeek
            );
            data.feeDistributor.adminFeeRate = feeDistributor_.adminFeeRate();
        }
    }

    function getControllerBallotData(address exchange, address account)
        public
        view
        returns (ControllerBallotData memory data)
    {
        ChessControllerV4 chessController =
            ChessControllerV4(address(ExchangeV2(exchange).chessController()));
        ControllerBallot controllerBallot =
            ControllerBallot(address(chessController.controllerBallot()));
        data.pools = controllerBallot.getPools();
        data.currentSums = new uint256[](data.pools.length);
        (data.account.amount, data.account.unlockTime) = controllerBallot.userLockedBalances(
            account
        );
        data.account.weights = new uint256[](data.pools.length);
        for (uint256 i = 0; i < data.pools.length; i++) {
            address pool = data.pools[i];
            data.currentSums[i] = controllerBallot.sumAtTimestamp(pool, block.timestamp);
            data.account.weights[i] = controllerBallot.userWeights(account, pool);
        }
    }

    function getSwapPairData(address swapPair) public view returns (SwapPairData memory data) {
        IUniswapV2Pair pair = IUniswapV2Pair(swapPair);
        data.token0 = pair.token0();
        data.token1 = pair.token1();
        (data.reserve0, data.reserve1, ) = pair.getReserves();
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
