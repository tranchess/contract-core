// SPDX-License-Identifier: GPL-3.0-or-later
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
import "../swap/LiquidityGaugeCurve.sol";
import "../swap/CurveRouter.sol";
import "../governance/InterestRateBallotV2.sol";
import "../governance/FeeDistributor.sol";
import "../governance/VotingEscrowV2.sol";
import "../governance/ControllerBallotV2.sol";

library LowLevelCheckedCall {
    function get(address target, bytes memory data) internal view returns (bytes memory ret) {
        bool success;
        (success, ret) = target.staticcall(data);
        require(success, "Low-level call failed");
    }

    function post(address target, bytes memory data) internal returns (bytes memory ret) {
        bool success;
        (success, ret) = target.call(data);
        require(success, "Low-level call failed");
    }
}

library LowLevelDecoder {
    function toUint(bytes memory data) internal pure returns (uint256) {
        return abi.decode(data, (uint256));
    }

    function toUints(bytes memory data) internal pure returns (uint256[] memory) {
        return abi.decode(data, (uint256[]));
    }

    function toUintUint(bytes memory data) internal pure returns (uint256, uint256) {
        return abi.decode(data, (uint256, uint256));
    }

    function toUintUintUint(bytes memory data)
        internal
        pure
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return abi.decode(data, (uint256, uint256, uint256));
    }

    function toUintUintUintUint(bytes memory data)
        internal
        pure
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        return abi.decode(data, (uint256, uint256, uint256, uint256));
    }

    function toUintUintUintUintUintUint(bytes memory data)
        internal
        pure
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        return abi.decode(data, (uint256, uint256, uint256, uint256, uint256, uint256));
    }

    function toBool(bytes memory data) internal pure returns (bool) {
        return abi.decode(data, (bool));
    }

    function toAddr(bytes memory data) internal pure returns (address) {
        return abi.decode(data, (address));
    }

    function toAddrs(bytes memory data) internal pure returns (address[] memory) {
        return abi.decode(data, (address[]));
    }

    function toString(bytes memory data) internal pure returns (string memory) {
        return abi.decode(data, (string));
    }
}

contract DataAggregator is ITrancheIndexV2, CoreUtility {
    using LowLevelCheckedCall for address;
    using LowLevelDecoder for bytes;

    struct Data {
        uint256 blockNumber;
        uint256 blockTimestamp;
        FundAllData[] funds;
        GovernanceData governance;
        FeeDistributorData[] feeDistributors;
        ExternalSwapData[] externalSwaps;
        CurveData[] curvePools;
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
        AnyCallSrcFee[] crossChainFees;
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

    struct AnyCallSrcFee {
        uint256 chainId;
        uint256 fee;
    }

    struct ExternalSwapData {
        string symbol0;
        string symbol1;
        uint112 reserve0;
        uint112 reserve1;
    }

    struct CurveData {
        CurvePoolData pool;
        CurveGaugeData gauge;
    }

    struct CurvePoolData {
        uint256 fee;
        address lpToken;
        address[2] coins;
        uint256[2] balances;
        uint256 priceOracle;
        uint256 lpTotalSupply;
        uint256 lpPrice;
        CurvePoolAccountData account;
    }

    struct CurvePoolAccountData {
        uint256[2] balances;
        uint256[2] allowances;
        uint256 lpBalance;
    }

    struct CurveGaugeData {
        uint256 chessRate;
        uint256 totalSupply;
        uint256 workingSupply;
        CurveGaugeAccountData account;
    }

    struct CurveGaugeAccountData {
        uint256 balance;
        uint256 allowance;
        uint256 workingBalance;
        uint256 claimableChess;
        uint256 claimableBonus;
    }

    string public constant VERSION = "2.0.0";

    address public immutable votingEscrow;
    address public immutable chessSchedule;
    address public immutable chess;
    address public immutable controllerBallot;
    address public immutable interestRateBallot;
    address public immutable swapRouter;
    address public immutable flashSwapRouter;
    address public immutable bishopQuoteToken;
    address public immutable anyCallProxy;
    uint256 private immutable _otherChainCount;

    uint256[255] public otherChainIds;

    constructor(
        address votingEscrow_,
        address chessSchedule_,
        address controllerBallot_,
        address interestRateBallot_,
        address swapRouter_,
        address flashSwapRouter_,
        address bishopQuoteToken_,
        address anyCallProxy_,
        uint256[] memory otherChainIds_
    ) public {
        votingEscrow = votingEscrow_;
        chessSchedule = chessSchedule_;
        chess = VotingEscrowV2(votingEscrow_).token();
        controllerBallot = controllerBallot_;
        interestRateBallot = interestRateBallot_;
        swapRouter = swapRouter_;
        flashSwapRouter = flashSwapRouter_;
        bishopQuoteToken = bishopQuoteToken_;
        anyCallProxy = anyCallProxy_;
        _otherChainCount = otherChainIds_.length;
        for (uint256 i = 0; i < otherChainIds_.length; i++) {
            otherChainIds[i] = otherChainIds_[i];
        }
    }

    function getData(
        address[] calldata primaryMarketRouters,
        address[] calldata shareStakings,
        address[] calldata feeDistributors,
        address[] calldata externalSwaps,
        address[] calldata curveRouters,
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
                externalSwaps[i * 3],
                externalSwaps[i * 3 + 1],
                externalSwaps[i * 3 + 2]
            );
        }

        data.curvePools = new CurveData[](curveRouters.length);
        for (uint256 i = 0; i < curveRouters.length; i++) {
            data.curvePools[i] = getCurveData(curveRouters[i], account);
        }
    }

    function getFundAllData(
        address primaryMarketRouter,
        address shareStaking,
        address account
    ) public returns (FundAllData memory data) {
        address fund =
            primaryMarketRouter
                .get(abi.encodeWithSelector(PrimaryMarketRouter(0).fund.selector))
                .toAddr();
        data.fund = getFundData(fund);

        address primaryMarket =
            primaryMarketRouter
                .get(abi.encodeWithSelector(PrimaryMarketRouter(0).primaryMarket.selector))
                .toAddr();
        data.primaryMarket = getPrimaryMarketData(primaryMarket);

        data.shareStaking = getShareStakingData(shareStaking, data.fund.splitRatio, account);

        address bishopStableSwap =
            swapRouter
                .get(
                abi.encodeWithSelector(
                    SwapRouter.getSwap.selector,
                    fund
                        .get(abi.encodeWithSelector(FundV3.tokenShare.selector, TRANCHE_B))
                        .toAddr(),
                    bishopQuoteToken
                )
            )
                .toAddr();
        data.bishopStableSwap = getStableSwapData(bishopStableSwap, account);

        address underlyingToken =
            fund.get(abi.encodeWithSelector(FundV3(0).tokenUnderlying.selector)).toAddr();
        address queenStableSwap =
            swapRouter
                .get(
                abi.encodeWithSelector(
                    SwapRouter.getSwap.selector,
                    fund
                        .get(abi.encodeWithSelector(FundV3.tokenShare.selector, TRANCHE_Q))
                        .toAddr(),
                    underlyingToken
                )
            )
                .toAddr();
        if (queenStableSwap != address(0)) {
            data.queenStableSwap = getStableSwapData(queenStableSwap, account);
        }

        data.account.balance.underlying = underlyingToken
            .get(abi.encodeWithSelector(IERC20.balanceOf.selector, account))
            .toUint();
        data.account.balance.quote = bishopQuoteToken
            .get(abi.encodeWithSelector(IERC20.balanceOf.selector, account))
            .toUint();
        (
            data.account.balance.trancheQ,
            data.account.balance.trancheB,
            data.account.balance.trancheR
        ) = fund
            .get(abi.encodeWithSelector(FundV3.trancheAllBalanceOf.selector, account))
            .toUintUintUint();

        data.account.allowance.primaryMarketRouterUnderlying = underlyingToken
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, primaryMarketRouter))
            .toUint();
        data.account.allowance.primaryMarketRouterTrancheQ = fund
            .get(
            abi.encodeWithSelector(
                FundV3.trancheAllowance.selector,
                TRANCHE_Q,
                account,
                primaryMarketRouter
            )
        )
            .toUint();
        data.account.allowance.swapRouterUnderlying = underlyingToken
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, swapRouter))
            .toUint();
        data.account.allowance.swapRouterTrancheQ = fund
            .get(
            abi.encodeWithSelector(FundV3.trancheAllowance.selector, TRANCHE_Q, account, swapRouter)
        )
            .toUint();
        data.account.allowance.swapRouterTrancheB = fund
            .get(
            abi.encodeWithSelector(FundV3.trancheAllowance.selector, TRANCHE_B, account, swapRouter)
        )
            .toUint();
        data.account.allowance.swapRouterQuote = bishopQuoteToken
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, swapRouter))
            .toUint();
        data.account.allowance.flashSwapRouterTrancheR = fund
            .get(
            abi.encodeWithSelector(
                FundV3.trancheAllowance.selector,
                TRANCHE_R,
                account,
                flashSwapRouter
            )
        )
            .toUint();
        data.account.allowance.flashSwapRouterQuote = bishopQuoteToken
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, flashSwapRouter))
            .toUint();
        data.account.allowance.shareStakingTrancheQ = fund
            .get(
            abi.encodeWithSelector(
                FundV3.trancheAllowance.selector,
                TRANCHE_Q,
                account,
                shareStaking
            )
        )
            .toUint();
        data.account.allowance.shareStakingTrancheB = fund
            .get(
            abi.encodeWithSelector(
                FundV3.trancheAllowance.selector,
                TRANCHE_B,
                account,
                shareStaking
            )
        )
            .toUint();
        data.account.allowance.shareStakingTrancheR = fund
            .get(
            abi.encodeWithSelector(
                FundV3.trancheAllowance.selector,
                TRANCHE_R,
                account,
                shareStaking
            )
        )
            .toUint();
    }

    function getFundData(address fund) public view returns (FundData memory data) {
        address twapOracle =
            fund.get(abi.encodeWithSelector(FundV3(0).twapOracle.selector)).toAddr();

        data.isFundActive = fund
            .get(abi.encodeWithSelector(FundV3.isFundActive.selector, block.timestamp))
            .toBool();
        data.fundActivityStartTime = fund
            .get(abi.encodeWithSelector(FundV3(0).fundActivityStartTime.selector))
            .toUint();
        data.activityDelayTimeAfterRebalance = fund
            .get(abi.encodeWithSelector(FundV3(0).activityDelayTimeAfterRebalance.selector))
            .toUint();
        data.currentDay = fund.get(abi.encodeWithSelector(FundV3(0).currentDay.selector)).toUint();
        data.dailyProtocolFeeRate = fund
            .get(abi.encodeWithSelector(FundV3(0).dailyProtocolFeeRate.selector))
            .toUint();
        data.totalSupplyQ = fund
            .get(abi.encodeWithSelector(FundV3.trancheTotalSupply.selector, TRANCHE_Q))
            .toUint();
        data.totalSupplyB = fund
            .get(abi.encodeWithSelector(FundV3.trancheTotalSupply.selector, TRANCHE_B))
            .toUint();
        data.totalUnderlying = fund
            .get(abi.encodeWithSelector(FundV3.getTotalUnderlying.selector))
            .toUint();
        data.strategyUnderlying = fund
            .get(abi.encodeWithSelector(FundV3.getStrategyUnderlying.selector))
            .toUint();
        data.rebalanceSize = fund
            .get(abi.encodeWithSelector(FundV3.getRebalanceSize.selector))
            .toUint();
        data.upperRebalanceThreshold = fund
            .get(abi.encodeWithSelector(FundV3(0).upperRebalanceThreshold.selector))
            .toUint();
        data.lowerRebalanceThreshold = fund
            .get(abi.encodeWithSelector(FundV3(0).lowerRebalanceThreshold.selector))
            .toUint();
        data.splitRatio = fund.get(abi.encodeWithSelector(FundV3(0).splitRatio.selector)).toUint();
        data.latestUnderlyingPrice = getLatestPrice(twapOracle);
        if (data.splitRatio != 0) {
            (, data.navB, data.navR) = fund
                .get(
                abi.encodeWithSelector(FundV3.extrapolateNav.selector, data.latestUnderlyingPrice)
            )
                .toUintUintUint();
            data.currentInterestRate = fund
                .get(
                abi.encodeWithSelector(
                    FundV3(0).historicalInterestRate.selector,
                    data.currentDay - 1 days
                )
            )
                .toUint();
        }
        (
            data.lastRebalance.ratioB2Q,
            data.lastRebalance.ratioR2Q,
            data.lastRebalance.ratioBR,
            data.lastRebalance.timestamp
        ) = fund
            .get(
            abi.encodeWithSelector(
                FundV3.getRebalance.selector,
                data.rebalanceSize == 0 ? 0 : data.rebalanceSize - 1
            )
        )
            .toUintUintUintUint();
    }

    function getLatestPrice(address twapOracle) public view returns (uint256) {
        (bool success, bytes memory encodedPrice) =
            twapOracle.staticcall(abi.encodeWithSelector(ITwapOracleV2.getLatest.selector));
        if (success) {
            return abi.decode(encodedPrice, (uint256));
        } else {
            uint256 lastEpoch = (block.timestamp / 30 minutes) * 30 minutes;
            for (uint256 i = 0; i < 48; i++) {
                // Search for the latest TWAP
                uint256 twap =
                    twapOracle
                        .get(
                        abi.encodeWithSelector(
                            ITwapOracle.getTwap.selector,
                            lastEpoch - i * 30 minutes
                        )
                    )
                        .toUint();
                if (twap != 0) {
                    return twap;
                }
            }
        }
    }

    function getPrimaryMarketData(address primaryMarket)
        public
        view
        returns (PrimaryMarketData memory data)
    {
        data.fundCap = primaryMarket
            .get(abi.encodeWithSelector(PrimaryMarketV3(0).fundCap.selector))
            .toUint();
        data.redemptionFeeRate = primaryMarket
            .get(abi.encodeWithSelector(PrimaryMarketV3(0).redemptionFeeRate.selector))
            .toUint();
        data.mergeFeeRate = primaryMarket
            .get(abi.encodeWithSelector(PrimaryMarketV3(0).mergeFeeRate.selector))
            .toUint();
        data.redemptionQueueHead = primaryMarket
            .get(abi.encodeWithSelector(PrimaryMarketV3.getNewRedemptionQueueHead.selector))
            .toUint();
    }

    function getShareStakingData(
        address shareStaking,
        uint256 splitRatio,
        address account
    ) public returns (ShareStakingData memory data) {
        if (shareStaking == address(0)) {
            return data;
        }
        data.account.claimableChess = shareStaking
            .post(abi.encodeWithSelector(ShareStaking.claimableRewards.selector, account))
            .toUint();
        data.totalSupplyQ = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.totalSupply.selector, TRANCHE_Q))
            .toUint();
        data.totalSupplyB = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.totalSupply.selector, TRANCHE_B))
            .toUint();
        data.totalSupplyR = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.totalSupply.selector, TRANCHE_R))
            .toUint();
        data.weightedSupply = shareStaking
            .get(
            abi.encodeWithSelector(
                ShareStaking.weightedBalance.selector,
                data.totalSupplyQ,
                data.totalSupplyB,
                data.totalSupplyR,
                splitRatio
            )
        )
            .toUint();
        data.workingSupply = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.workingSupply.selector))
            .toUint();
        data.chessRate = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.getRate.selector))
            .toUint();
        data.account.balanceQ = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.trancheBalanceOf.selector, TRANCHE_Q, account))
            .toUint();
        data.account.balanceB = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.trancheBalanceOf.selector, TRANCHE_B, account))
            .toUint();
        data.account.balanceR = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.trancheBalanceOf.selector, TRANCHE_R, account))
            .toUint();
        data.account.weightedBalance = shareStaking
            .get(
            abi.encodeWithSelector(
                ShareStaking.weightedBalance.selector,
                data.account.balanceQ,
                data.account.balanceB,
                data.account.balanceR,
                splitRatio
            )
        )
            .toUint();
        data.account.workingBalance = shareStaking
            .get(abi.encodeWithSelector(ShareStaking.workingBalanceOf.selector, account))
            .toUint();
    }

    function getStableSwapData(address stableSwap, address account)
        public
        returns (StableSwapData memory data)
    {
        address lp =
            stableSwap.get(abi.encodeWithSelector(StableSwap(0).lpToken.selector)).toAddr();
        address swapBonus =
            lp.get(abi.encodeWithSelector(LiquidityGauge(0).swapBonus.selector)).toAddr();

        // Trigger checkpoint
        (
            data.account.claimableChess,
            data.account.claimableBonus,
            data.account.claimableQ,
            data.account.claimableB,
            data.account.claimableR,
            data.account.claimableQuote
        ) = lp
            .post(abi.encodeWithSelector(LiquidityGauge.claimableRewards.selector, account))
            .toUintUintUintUintUintUint();
        data.account.lpBalance = lp
            .get(abi.encodeWithSelector(LiquidityGauge(0).balanceOf.selector, account))
            .toUint();
        data.account.workingBalance = lp
            .get(abi.encodeWithSelector(LiquidityGauge.workingBalanceOf.selector, account))
            .toUint();

        data.feeRate = stableSwap
            .get(abi.encodeWithSelector(StableSwap(0).feeRate.selector))
            .toUint();
        data.adminFeeRate = stableSwap
            .get(abi.encodeWithSelector(StableSwap(0).adminFeeRate.selector))
            .toUint();
        data.ampl = stableSwap.get(abi.encodeWithSelector(StableSwap.getAmpl.selector)).toUint();
        data.lpTotalSupply = lp
            .get(abi.encodeWithSelector(LiquidityGauge(0).totalSupply.selector))
            .toUint();
        if (data.lpTotalSupply != 0) {
            // Handle rebalance
            stableSwap.post(abi.encodeWithSelector(StableSwap.sync.selector));
        }
        data.lpWorkingSupply = lp
            .get(abi.encodeWithSelector(LiquidityGauge.workingSupply.selector))
            .toUint();
        (data.baseBalance, data.quoteBalance) = stableSwap
            .get(abi.encodeWithSelector(StableSwap.allBalances.selector))
            .toUintUint();
        data.chessRate = lp.get(abi.encodeWithSelector(LiquidityGauge.getRate.selector)).toUint();
        uint256 lpVersion =
            lp.get(abi.encodeWithSelector(LiquidityGauge(0).latestVersion.selector)).toUint();
        (
            data.lastDistributionQ,
            data.lastDistributionB,
            data.lastDistributionR,
            data.lastDistributionQuote
        ) = lp
            .get(abi.encodeWithSelector(LiquidityGauge(0).distributions.selector, lpVersion))
            .toUintUintUintUint();
        data.lastDistributionTotalSupply = lp
            .get(
            abi.encodeWithSelector(LiquidityGauge(0).distributionTotalSupplies.selector, lpVersion)
        )
            .toUint();
        data.bonusToken = swapBonus
            .get(abi.encodeWithSelector(SwapBonus(0).bonusToken.selector))
            .toAddr();
        data.bonusRate = block.timestamp <
            swapBonus.get(abi.encodeWithSelector(SwapBonus(0).endTimestamp.selector)).toUint()
            ? swapBonus.get(abi.encodeWithSelector(SwapBonus(0).ratePerSecond.selector)).toUint()
            : 0;

        (bool success, bytes memory encodedOraclePrice) =
            stableSwap.staticcall(abi.encodeWithSelector(StableSwap.getOraclePrice.selector));
        if (success) {
            data.currentD = stableSwap
                .get(abi.encodeWithSelector(StableSwap.getCurrentD.selector))
                .toUint();
            data.currentPrice = stableSwap
                .get(abi.encodeWithSelector(StableSwap.getCurrentPrice.selector))
                .toUint();
            data.oraclePrice = abi.decode(encodedOraclePrice, (uint256));
        }
    }

    function getGovernanceData(address account) public view returns (GovernanceData memory data) {
        uint256 blockCurrentWeek = _endOfWeek(block.timestamp);

        data.chessRate = chessSchedule
            .get(abi.encodeWithSelector(IChessSchedule.getRate.selector, block.timestamp))
            .toUint();
        data.nextWeekChessRate = chessSchedule
            .get(abi.encodeWithSelector(IChessSchedule.getRate.selector, block.timestamp + 1 weeks))
            .toUint();

        data.votingEscrow.totalLocked = votingEscrow
            .get(abi.encodeWithSelector(VotingEscrowV2(0).totalLocked.selector))
            .toUint();
        data.votingEscrow.totalSupply = votingEscrow
            .get(abi.encodeWithSelector(VotingEscrowV2.totalSupply.selector))
            .toUint();
        data.votingEscrow.tradingWeekTotalSupply = votingEscrow
            .get(
            abi.encodeWithSelector(VotingEscrowV2.totalSupplyAtTimestamp.selector, blockCurrentWeek)
        )
            .toUint();
        data.votingEscrow.crossChainFees = new AnyCallSrcFee[](_otherChainCount);
        for (uint256 i = 0; i < _otherChainCount; i++) {
            AnyCallSrcFee memory fee = data.votingEscrow.crossChainFees[i];
            fee.chainId = otherChainIds[i];
            fee.fee = anyCallProxy
                .get(
                abi.encodeWithSignature(
                    "calcSrcFees(address,uint256,uint256)",
                    votingEscrow,
                    fee.chainId,
                    96
                )
            )
                .toUint();
        }
        (data.votingEscrow.account.amount, data.votingEscrow.account.unlockTime) = votingEscrow
            .get(abi.encodeWithSelector(VotingEscrowV2.getLockedBalance.selector, account))
            .toUintUint();

        data.interestRateBallot.tradingWeekTotalSupply = interestRateBallot
            .get(
            abi.encodeWithSelector(
                InterestRateBallotV2.totalSupplyAtWeek.selector,
                blockCurrentWeek
            )
        )
            .toUint();
        data.interestRateBallot.tradingWeekAverage = interestRateBallot
            .get(
            abi.encodeWithSelector(InterestRateBallotV2.averageAtWeek.selector, blockCurrentWeek)
        )
            .toUint();
        data.interestRateBallot.lastWeekAverage = interestRateBallot
            .get(
            abi.encodeWithSelector(
                InterestRateBallotV2.averageAtWeek.selector,
                blockCurrentWeek - 1 weeks
            )
        )
            .toUint();
        (
            data.interestRateBallot.account.amount,
            data.interestRateBallot.account.unlockTime,
            data.interestRateBallot.account.weight
        ) = interestRateBallot
            .get(abi.encodeWithSelector(InterestRateBallotV2.getReceipt.selector, account))
            .toUintUintUint();

        data.controllerBallot = getControllerBallotData(account);

        data.account.balance.nativeCurrency = account.balance;
        data.account.balance.chess = chess
            .get(abi.encodeWithSelector(IERC20.balanceOf.selector, account))
            .toUint();
        data.account.allowance.votingEscrowChess = chess
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, votingEscrow))
            .toUint();
    }

    function getControllerBallotData(address account)
        public
        view
        returns (ControllerBallotData memory data)
    {
        data.pools = controllerBallot
            .get(abi.encodeWithSelector(ControllerBallotV2.getPools.selector))
            .toAddrs();
        // TODO handle disabled pools
        data.currentSums = new uint256[](data.pools.length);
        (data.account.amount, data.account.unlockTime) = controllerBallot
            .get(abi.encodeWithSelector(ControllerBallotV2(0).userLockedBalances.selector, account))
            .toUintUint();
        data.account.weights = new uint256[](data.pools.length);
        for (uint256 i = 0; i < data.pools.length; i++) {
            address pool = data.pools[i];
            data.currentSums[i] = controllerBallot
                .get(
                abi.encodeWithSelector(
                    ControllerBallotV2.sumAtWeek.selector,
                    pool,
                    _endOfWeek(block.timestamp)
                )
            )
                .toUint();
            data.account.weights[i] = controllerBallot
                .get(
                abi.encodeWithSelector(ControllerBallotV2(0).userWeights.selector, account, pool)
            )
                .toUint();
        }
    }

    function getFeeDistributorData(address feeDistributor, address account)
        public
        returns (FeeDistributorData memory data)
    {
        data.account.claimableRewards = feeDistributor
            .post(abi.encodeWithSelector(FeeDistributor.userCheckpoint.selector, account))
            .toUint();
        data.account.currentBalance = feeDistributor
            .get(abi.encodeWithSelector(FeeDistributor(0).userLastBalances.selector, account))
            .toUint();
        (data.account.amount, data.account.unlockTime) = feeDistributor
            .get(abi.encodeWithSelector(FeeDistributor(0).userLockedBalances.selector, account))
            .toUintUint();
        uint256 blockCurrentWeek = _endOfWeek(block.timestamp);
        data.currentRewards = feeDistributor
            .get(
            abi.encodeWithSelector(
                FeeDistributor(0).rewardsPerWeek.selector,
                blockCurrentWeek - 1 weeks
            )
        )
            .toUint();
        data.currentSupply = feeDistributor
            .get(
            abi.encodeWithSelector(
                FeeDistributor(0).veSupplyPerWeek.selector,
                blockCurrentWeek - 1 weeks
            )
        )
            .toUint();
        data.tradingWeekTotalSupply = feeDistributor
            .get(
            abi.encodeWithSelector(FeeDistributor.totalSupplyAtTimestamp.selector, blockCurrentWeek)
        )
            .toUint();
        data.adminFeeRate = feeDistributor
            .get(abi.encodeWithSelector(FeeDistributor(0).adminFeeRate.selector))
            .toUint();
    }

    function getExternalSwapData(
        address router,
        address token0,
        address token1
    ) public view returns (ExternalSwapData memory data) {
        IUniswapV2Pair pair =
            IUniswapV2Pair(
                router
                    .get(abi.encodeWithSelector(IUniswapV2Router01.factory.selector))
                    .toAddr()
                    .get(abi.encodeWithSelector(IUniswapV2Factory.getPair.selector, token0, token1))
                    .toAddr()
            );
        data.symbol0 = token0
            .get(abi.encodeWithSelector(IUniswapV2Pair.symbol.selector))
            .toString();
        data.symbol1 = token1
            .get(abi.encodeWithSelector(IUniswapV2Pair.symbol.selector))
            .toString();
        if (
            address(pair).get(abi.encodeWithSelector(IUniswapV2Pair.token0.selector)).toAddr() ==
            token0
        ) {
            (data.reserve0, data.reserve1, ) = pair.getReserves();
        } else {
            (data.reserve1, data.reserve0, ) = pair.getReserves();
        }
    }

    function getCurveData(address curveRouter, address account)
        public
        returns (CurveData memory data)
    {
        data.pool = getCurvePoolData(curveRouter, account);
        data.gauge = getCurveGaugeData(curveRouter, account);
    }

    function getCurvePoolData(address curveRouter, address account)
        public
        view
        returns (CurvePoolData memory data)
    {
        address pool =
            curveRouter.get(abi.encodeWithSelector(CurveRouter(0).curvePool.selector)).toAddr();
        address lp =
            curveRouter
                .get(abi.encodeWithSelector(CurveRouter(0).curveLiquidityToken.selector))
                .toAddr();
        data.fee = pool.get(abi.encodeWithSignature("fee()")).toUint();
        data.lpToken = lp;
        data.coins[0] = pool.get(abi.encodeWithSignature("coins(uint256)", 0)).toAddr();
        data.coins[1] = pool.get(abi.encodeWithSignature("coins(uint256)", 1)).toAddr();
        data.balances[0] = pool.get(abi.encodeWithSignature("balances(uint256)", 0)).toUint();
        data.balances[1] = pool.get(abi.encodeWithSignature("balances(uint256)", 1)).toUint();
        data.priceOracle = pool.get(abi.encodeWithSignature("price_oracle()")).toUint();
        data.lpTotalSupply = lp.get(abi.encodeWithSignature("totalSupply()")).toUint();
        data.lpPrice = pool.get(abi.encodeWithSignature("lp_price()")).toUint();

        data.account.balances[0] = data.coins[0]
            .get(abi.encodeWithSelector(IERC20.balanceOf.selector, account))
            .toUint();
        data.account.balances[1] = data.coins[1]
            .get(abi.encodeWithSelector(IERC20.balanceOf.selector, account))
            .toUint();
        data.account.allowances[0] = data.coins[0]
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, curveRouter))
            .toUint();
        data.account.allowances[1] = data.coins[1]
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, curveRouter))
            .toUint();
        data.account.lpBalance = lp
            .get(abi.encodeWithSelector(IERC20.balanceOf.selector, account))
            .toUint();
    }

    function getCurveGaugeData(address curveRouter, address account)
        public
        returns (CurveGaugeData memory data)
    {
        address gauge =
            curveRouter
                .get(abi.encodeWithSelector(CurveRouter(0).tranchessLiquidityGauge.selector))
                .toAddr();
        address lp =
            curveRouter
                .get(abi.encodeWithSelector(CurveRouter(0).curveLiquidityToken.selector))
                .toAddr();
        (data.account.claimableChess, data.account.claimableBonus) = gauge
            .post(abi.encodeWithSelector(LiquidityGaugeCurve.claimableRewards.selector, account))
            .toUintUint();
        data.account.balance = gauge
            .post(abi.encodeWithSelector(LiquidityGaugeCurve(0).balanceOf.selector, account))
            .toUint();
        data.account.allowance = lp
            .get(abi.encodeWithSelector(IERC20.allowance.selector, account, gauge))
            .toUint();
        data.account.workingBalance = gauge
            .post(abi.encodeWithSelector(LiquidityGaugeCurve.workingBalanceOf.selector, account))
            .toUint();

        data.chessRate = gauge
            .get(abi.encodeWithSelector(LiquidityGaugeCurve.getRate.selector))
            .toUint();
        data.totalSupply = gauge
            .get(abi.encodeWithSelector(LiquidityGaugeCurve(0).totalSupply.selector))
            .toUint();
        data.workingSupply = gauge
            .get(abi.encodeWithSelector(LiquidityGaugeCurve.workingSupply.selector))
            .toUint();
    }
}
