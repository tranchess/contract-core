// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router01.sol";

import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IChessSchedule.sol";
import "../utils/CoreUtility.sol";

import "../fund/FundV3.sol";
import "../fund/PrimaryMarketV3.sol";
import "../fund/PrimaryMarketRouter.sol";
import "../fund/ShareStaking.sol";
import "../swap/StableSwap.sol";
import "../swap/LiquidityGauge.sol";
import "../swap/SwapBonus.sol";
import "../swap/SwapRouter.sol";
import "../governance/InterestRateBallotV2.sol";
import "../governance/FeeDistributor.sol";
import "../governance/VotingEscrowV2.sol";
import "../governance/ControllerBallot.sol";

contract DataAggregator is ITrancheIndexV2, CoreUtility {
    struct Data {
        uint256 blockNumber;
        uint256 blockTimestamp;
        FundAllData[] funds;
        GovernanceData governance;
        FeeDistributorData[] feeDistributors;
        ExternalSwapData[] externalSwaps;
    }

    struct FundAllData {
        FundData fund;
        PrimaryMarketData primaryMarket;
        ShareStakingData shareStaking;
        StableSwapData bishopStableSwap;
        StableSwapData queenStableSwap;
        FundAccountData account;
    }

    struct FundData {
        bool isFundActive;
        uint256 fundActivityStartTime;
        uint256 activityDelayTimeAfterRebalance;
        uint256 currentDay;
        uint256 dailyProtocolFeeRate;
        uint256 totalSupplyQ;
        uint256 totalSupplyB;
        uint256 totalUnderlying;
        uint256 strategyUnderlying;
        uint256 rebalanceSize;
        uint256 upperRebalanceThreshold;
        uint256 lowerRebalanceThreshold;
        uint256 splitRatio;
        uint256 latestUnderlyingPrice;
        uint256 navB;
        uint256 navR;
        uint256 currentInterestRate;
        FundV3.Rebalance lastRebalance;
    }

    struct PrimaryMarketData {
        uint256 fundCap;
        uint256 redemptionFeeRate;
        uint256 mergeFeeRate;
        uint256 redemptionQueueHead;
    }

    struct ShareStakingData {
        uint256 totalSupplyQ;
        uint256 totalSupplyB;
        uint256 totalSupplyR;
        uint256 weightedSupply;
        uint256 workingSupply;
        uint256 chessRate;
        ShareStakingAccountData account;
    }

    struct ShareStakingAccountData {
        uint256 balanceQ;
        uint256 balanceB;
        uint256 balanceR;
        uint256 weightedBalance;
        uint256 workingBalance;
        uint256 claimableChess;
    }

    struct StableSwapData {
        uint256 feeRate;
        uint256 adminFeeRate;
        uint256 ampl;
        uint256 currentD;
        uint256 currentPrice;
        uint256 baseBalance;
        uint256 quoteBalance;
        uint256 oraclePrice;
        uint256 lpTotalSupply;
        uint256 lpWorkingSupply;
        uint256 chessRate;
        uint256 lastDistributionQ;
        uint256 lastDistributionB;
        uint256 lastDistributionR;
        uint256 lastDistributionQuote;
        uint256 lastDistributionTotalSupply;
        address bonusToken;
        uint256 bonusRate;
        StableSwapAccountData account;
    }

    struct StableSwapAccountData {
        uint256 lpBalance;
        uint256 workingBalance;
        uint256 claimableChess;
        uint256 claimableBonus;
        uint256 claimableQ;
        uint256 claimableB;
        uint256 claimableR;
        uint256 claimableQuote;
    }

    struct FundAccountData {
        FundAccountBalanceData balance;
        FundAccountAllowanceData allowance;
    }

    struct FundAccountBalanceData {
        uint256 underlying;
        uint256 quote;
        uint256 trancheQ;
        uint256 trancheB;
        uint256 trancheR;
    }

    struct FundAccountAllowanceData {
        uint256 primaryMarketRouterUnderlying;
        uint256 primaryMarketRouterTrancheQ;
        uint256 swapRouterUnderlying;
        uint256 swapRouterTrancheQ;
        uint256 swapRouterTrancheB;
        uint256 swapRouterQuote;
        uint256 flashSwapRouterTrancheR;
        uint256 flashSwapRouterQuote;
        uint256 shareStakingTrancheQ;
        uint256 shareStakingTrancheB;
        uint256 shareStakingTrancheR;
    }

    struct GovernanceData {
        uint256 chessRate;
        uint256 nextWeekChessRate;
        VotingEscrowData votingEscrow;
        InterestRateBallotData interestRateBallot;
        ControllerBallotData controllerBallot;
        GovernanceAccountData account;
    }

    struct VotingEscrowData {
        uint256 totalLocked;
        uint256 totalSupply;
        uint256 tradingWeekTotalSupply;
        IVotingEscrow.LockedBalance account;
    }

    struct InterestRateBallotData {
        uint256 tradingWeekTotalSupply;
        uint256 tradingWeekAverage;
        uint256 lastWeekAverage;
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

    struct GovernanceAccountData {
        GovernanceAccountBalanceData balance;
        GovernanceAccountAllowanceData allowance;
    }

    struct GovernanceAccountBalanceData {
        uint256 nativeCurrency;
        uint256 chess;
    }

    struct GovernanceAccountAllowanceData {
        uint256 votingEscrowChess;
    }

    struct FeeDistributorData {
        uint256 currentRewards;
        uint256 currentSupply;
        uint256 tradingWeekTotalSupply;
        uint256 adminFeeRate;
        FeeDistributorAccountData account;
    }

    struct FeeDistributorAccountData {
        uint256 claimableRewards;
        uint256 currentBalance;
        uint256 amount;
        uint256 unlockTime;
    }

    struct ExternalSwapData {
        string symbol0;
        string symbol1;
        uint112 reserve0;
        uint112 reserve1;
    }

    string public constant VERSION = "2.0.0";

    VotingEscrowV2 public immutable votingEscrow;
    IChessSchedule public immutable chessSchedule;
    IERC20 public immutable chess;
    ControllerBallot public immutable controllerBallot;
    InterestRateBallotV2 public immutable interestRateBallot;
    SwapRouter public immutable swapRouter;
    address public immutable flashSwapRouter;
    IERC20 public immutable bishopQuoteToken;

    constructor(
        VotingEscrowV2 votingEscrow_,
        IChessSchedule chessSchedule_,
        ControllerBallot controllerBallot_,
        InterestRateBallotV2 interestRateBallot_,
        SwapRouter swapRouter_,
        address flashSwapRouter_,
        IERC20 bishopQuoteToken_
    ) public {
        votingEscrow = votingEscrow_;
        chessSchedule = chessSchedule_;
        chess = IERC20(votingEscrow_.token());
        controllerBallot = controllerBallot_;
        interestRateBallot = interestRateBallot_;
        swapRouter = swapRouter_;
        flashSwapRouter = flashSwapRouter_;
        bishopQuoteToken = bishopQuoteToken_;
    }

    function getData(
        PrimaryMarketRouter[] calldata primaryMarketRouters,
        ShareStaking[] calldata shareStakings,
        FeeDistributor[] calldata feeDistributors,
        address[] calldata externalSwaps,
        address account
    ) public returns (Data memory data) {
        data.blockNumber = block.number;
        data.blockTimestamp = block.timestamp;

        data.funds = new FundAllData[](primaryMarketRouters.length);
        for (uint256 i = 0; i < primaryMarketRouters.length; i++) {
            data.funds[i] = getFundAllData(primaryMarketRouters[i], shareStakings[i], account);
        }

        data.governance = getGovernanceData(account);

        data.feeDistributors = new FeeDistributorData[](feeDistributors.length);
        for (uint256 i = 0; i < feeDistributors.length; i++) {
            data.feeDistributors[i] = getFeeDistributorData(feeDistributors[i], account);
        }

        data.externalSwaps = new ExternalSwapData[](externalSwaps.length / 3);
        for (uint256 i = 0; i < externalSwaps.length / 3; i++) {
            data.externalSwaps[i] = getExternalSwapData(
                IUniswapV2Router01(externalSwaps[i * 3]),
                externalSwaps[i * 3 + 1],
                externalSwaps[i * 3 + 2]
            );
        }
    }

    function getFundAllData(
        PrimaryMarketRouter primaryMarketRouter,
        ShareStaking shareStaking,
        address account
    ) public returns (FundAllData memory data) {
        FundV3 fund = FundV3(address(primaryMarketRouter.fund()));
        data.fund = getFundData(fund);

        PrimaryMarketV3 primaryMarket =
            PrimaryMarketV3(payable(address(primaryMarketRouter.primaryMarket())));
        data.primaryMarket = getPrimaryMarketData(primaryMarket);

        data.shareStaking = getShareStakingData(shareStaking, data.fund.splitRatio, account);

        StableSwap bishopStableSwap =
            StableSwap(
                payable(
                    address(
                        swapRouter.getSwap(fund.tokenShare(TRANCHE_B), address(bishopQuoteToken))
                    )
                )
            );
        data.bishopStableSwap = getStableSwapData(bishopStableSwap, account);

        IERC20 underlyingToken = IERC20(fund.tokenUnderlying());
        StableSwap queenStableSwap =
            StableSwap(
                payable(
                    address(
                        swapRouter.getSwap(fund.tokenShare(TRANCHE_Q), address(underlyingToken))
                    )
                )
            );
        if (address(queenStableSwap) != address(0)) {
            data.queenStableSwap = getStableSwapData(queenStableSwap, account);
        }

        data.account.balance.underlying = underlyingToken.balanceOf(account);
        data.account.balance.quote = bishopQuoteToken.balanceOf(account);
        (
            data.account.balance.trancheQ,
            data.account.balance.trancheB,
            data.account.balance.trancheR
        ) = fund.trancheAllBalanceOf(account);

        data.account.allowance.primaryMarketRouterUnderlying = underlyingToken.allowance(
            account,
            address(primaryMarketRouter)
        );
        data.account.allowance.primaryMarketRouterTrancheQ = fund.trancheAllowance(
            TRANCHE_Q,
            account,
            address(primaryMarketRouter)
        );
        data.account.allowance.swapRouterUnderlying = underlyingToken.allowance(
            account,
            address(swapRouter)
        );
        data.account.allowance.swapRouterTrancheQ = fund.trancheAllowance(
            TRANCHE_Q,
            account,
            address(swapRouter)
        );
        data.account.allowance.swapRouterTrancheB = fund.trancheAllowance(
            TRANCHE_B,
            account,
            address(swapRouter)
        );
        data.account.allowance.swapRouterQuote = bishopQuoteToken.allowance(
            account,
            address(swapRouter)
        );
        data.account.allowance.flashSwapRouterTrancheR = fund.trancheAllowance(
            TRANCHE_R,
            account,
            flashSwapRouter
        );
        data.account.allowance.flashSwapRouterQuote = bishopQuoteToken.allowance(
            account,
            flashSwapRouter
        );
        data.account.allowance.shareStakingTrancheQ = fund.trancheAllowance(
            TRANCHE_Q,
            account,
            address(shareStaking)
        );
        data.account.allowance.shareStakingTrancheB = fund.trancheAllowance(
            TRANCHE_B,
            account,
            address(shareStaking)
        );
        data.account.allowance.shareStakingTrancheR = fund.trancheAllowance(
            TRANCHE_R,
            account,
            address(shareStaking)
        );
    }

    function getFundData(FundV3 fund) public view returns (FundData memory data) {
        ITwapOracleV2 twapOracle = fund.twapOracle();

        data.isFundActive = fund.isFundActive(block.timestamp);
        data.fundActivityStartTime = fund.fundActivityStartTime();
        data.activityDelayTimeAfterRebalance = fund.activityDelayTimeAfterRebalance();
        data.currentDay = fund.currentDay();
        data.dailyProtocolFeeRate = fund.dailyProtocolFeeRate();
        data.totalSupplyQ = fund.trancheTotalSupply(TRANCHE_Q);
        data.totalSupplyB = fund.trancheTotalSupply(TRANCHE_B);
        data.totalUnderlying = fund.getTotalUnderlying();
        data.strategyUnderlying = fund.getStrategyUnderlying();
        data.rebalanceSize = fund.getRebalanceSize();
        data.upperRebalanceThreshold = fund.upperRebalanceThreshold();
        data.lowerRebalanceThreshold = fund.lowerRebalanceThreshold();
        data.splitRatio = fund.splitRatio();
        data.latestUnderlyingPrice = getLatestPrice(twapOracle);
        if (data.splitRatio != 0) {
            (, data.navB, data.navR) = fund.extrapolateNav(data.latestUnderlyingPrice);
            data.currentInterestRate = fund.historicalInterestRate(data.currentDay - 1 days);
        }
        data.lastRebalance = fund.getRebalance(
            data.rebalanceSize == 0 ? 0 : data.rebalanceSize - 1
        );
    }

    function getLatestPrice(ITwapOracleV2 twapOracle) public view returns (uint256) {
        (bool success, bytes memory encodedPrice) =
            address(twapOracle).staticcall(abi.encodeWithSignature("getLatest()"));
        if (success) {
            return abi.decode(encodedPrice, (uint256));
        } else {
            uint256 lastEpoch = (block.timestamp / 30 minutes) * 30 minutes;
            for (uint256 i = 0; i < 48; i++) {
                // Search for the latest TWAP
                uint256 twap = twapOracle.getTwap(lastEpoch - i * 30 minutes);
                if (twap != 0) {
                    return twap;
                }
            }
        }
    }

    function getPrimaryMarketData(PrimaryMarketV3 primaryMarket)
        public
        view
        returns (PrimaryMarketData memory data)
    {
        data.fundCap = primaryMarket.fundCap();
        data.redemptionFeeRate = primaryMarket.redemptionFeeRate();
        data.mergeFeeRate = primaryMarket.mergeFeeRate();
        data.redemptionQueueHead = primaryMarket.getNewRedemptionQueueHead();
    }

    function getShareStakingData(
        ShareStaking shareStaking,
        uint256 splitRatio,
        address account
    ) public returns (ShareStakingData memory data) {
        data.account.claimableChess = shareStaking.claimableRewards(account);
        data.totalSupplyQ = shareStaking.totalSupply(TRANCHE_Q);
        data.totalSupplyB = shareStaking.totalSupply(TRANCHE_B);
        data.totalSupplyR = shareStaking.totalSupply(TRANCHE_R);
        data.weightedSupply = shareStaking.weightedBalance(
            data.totalSupplyQ,
            data.totalSupplyB,
            data.totalSupplyR,
            splitRatio
        );
        data.workingSupply = shareStaking.workingSupply();
        data.chessRate = shareStaking.getRate();
        data.account.balanceQ = shareStaking.trancheBalanceOf(TRANCHE_Q, account);
        data.account.balanceB = shareStaking.trancheBalanceOf(TRANCHE_B, account);
        data.account.balanceR = shareStaking.trancheBalanceOf(TRANCHE_R, account);
        data.account.weightedBalance = shareStaking.weightedBalance(
            data.account.balanceQ,
            data.account.balanceB,
            data.account.balanceR,
            splitRatio
        );
        data.account.workingBalance = shareStaking.workingBalanceOf(account);
    }

    function getStableSwapData(StableSwap stableSwap, address account)
        public
        returns (StableSwapData memory data)
    {
        LiquidityGauge lp = LiquidityGauge(stableSwap.lpToken());
        SwapBonus swapBonus = SwapBonus(lp.swapBonus());

        // Trigger checkpoint
        (
            data.account.claimableChess,
            data.account.claimableBonus,
            data.account.claimableQ,
            data.account.claimableB,
            data.account.claimableR,
            data.account.claimableQuote
        ) = lp.claimableRewards(account);
        data.account.lpBalance = lp.balanceOf(account);
        data.account.workingBalance = lp.workingBalanceOf(account);

        data.feeRate = stableSwap.feeRate();
        data.adminFeeRate = stableSwap.adminFeeRate();
        data.ampl = stableSwap.getAmpl();
        data.lpTotalSupply = lp.totalSupply();
        if (data.lpTotalSupply != 0) {
            // Handle rebalance
            stableSwap.sync();
        }
        data.lpWorkingSupply = lp.workingSupply();
        (data.baseBalance, data.quoteBalance) = stableSwap.allBalances();
        data.chessRate = lp.getRate();
        uint256 lpVersion = lp.latestVersion();
        (
            data.lastDistributionQ,
            data.lastDistributionB,
            data.lastDistributionR,
            data.lastDistributionQuote
        ) = lp.distributions(lpVersion);
        data.lastDistributionTotalSupply = lp.distributionTotalSupplies(lpVersion);
        data.bonusToken = swapBonus.bonusToken();
        data.bonusRate = block.timestamp < swapBonus.endTimestamp() ? swapBonus.ratePerSecond() : 0;

        (bool success, bytes memory encodedOraclePrice) =
            address(stableSwap).call(abi.encodeWithSignature("getOraclePrice()"));
        if (success) {
            data.currentD = stableSwap.getCurrentD();
            data.currentPrice = stableSwap.getCurrentPrice();
            data.oraclePrice = abi.decode(encodedOraclePrice, (uint256));
        }
    }

    function getGovernanceData(address account) public view returns (GovernanceData memory data) {
        uint256 blockCurrentWeek = _endOfWeek(block.timestamp);

        data.chessRate = chessSchedule.getRate(block.timestamp);
        data.nextWeekChessRate = chessSchedule.getRate(block.timestamp + 1 weeks);

        data.votingEscrow.totalLocked = votingEscrow.totalLocked();
        data.votingEscrow.totalSupply = votingEscrow.totalSupply();
        data.votingEscrow.tradingWeekTotalSupply = votingEscrow.totalSupplyAtTimestamp(
            blockCurrentWeek
        );
        data.votingEscrow.account = votingEscrow.getLockedBalance(account);

        data.interestRateBallot.tradingWeekTotalSupply = interestRateBallot.totalSupplyAtWeek(
            blockCurrentWeek
        );
        data.interestRateBallot.tradingWeekAverage = interestRateBallot.averageAtWeek(
            blockCurrentWeek
        );
        data.interestRateBallot.lastWeekAverage = interestRateBallot.averageAtWeek(
            blockCurrentWeek - 1 weeks
        );
        data.interestRateBallot.account = interestRateBallot.getReceipt(account);

        data.controllerBallot = getControllerBallotData(account);

        data.account.balance.nativeCurrency = account.balance;
        data.account.balance.chess = chess.balanceOf(account);
        data.account.allowance.votingEscrowChess = chess.allowance(account, address(votingEscrow));
    }

    function getControllerBallotData(address account)
        public
        view
        returns (ControllerBallotData memory data)
    {
        data.pools = controllerBallot.getPools();
        // TODO handle disabled pools
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

    function getFeeDistributorData(FeeDistributor feeDistributor, address account)
        public
        returns (FeeDistributorData memory data)
    {
        data.account.claimableRewards = feeDistributor.userCheckpoint(account);
        data.account.currentBalance = feeDistributor.userLastBalances(account);
        (data.account.amount, data.account.unlockTime) = feeDistributor.userLockedBalances(account);
        uint256 blockCurrentWeek = _endOfWeek(block.timestamp);
        data.currentRewards = feeDistributor.rewardsPerWeek(blockCurrentWeek - 1 weeks);
        data.currentSupply = feeDistributor.veSupplyPerWeek(blockCurrentWeek - 1 weeks);
        data.tradingWeekTotalSupply = feeDistributor.totalSupplyAtTimestamp(blockCurrentWeek);
        data.adminFeeRate = feeDistributor.adminFeeRate();
    }

    function getExternalSwapData(
        IUniswapV2Router01 router,
        address token0,
        address token1
    ) public view returns (ExternalSwapData memory data) {
        IUniswapV2Pair pair =
            IUniswapV2Pair(IUniswapV2Factory(router.factory()).getPair(token0, token1));
        data.symbol0 = ERC20(token0).symbol();
        data.symbol1 = ERC20(token1).symbol();
        if (pair.token0() == token0) {
            (data.reserve0, data.reserve1, ) = pair.getReserves();
        } else {
            (data.reserve1, data.reserve0, ) = pair.getReserves();
        }
    }
}
