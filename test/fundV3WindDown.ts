import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;

import { deployMockForName } from "./mock";
import {
    TRANCHE_Q,
    TRANCHE_B,
    TRANCHE_R,
    DAY,
    HOUR,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
} from "./utils";

const ROLE_UPDATE_MIN_DELAY = DAY * 3;

function endOfDay(timestamp: number): number {
    return Math.floor((timestamp + DAY - SETTLEMENT_TIME) / DAY) * DAY + SETTLEMENT_TIME;
}

describe("FundV3WindDown", function () {
    interface BasicFixtureData {
        readonly wallets: FixtureWalletMap;
        readonly freezeDay: number;
        readonly fund: string;
        readonly fundMock: MockContract;
        readonly oldTwapOracle: MockContract;
        readonly oldAprOracle: MockContract;
        readonly windDown: Contract;
    }

    interface IntegrationFixtureData {
        readonly wallets: FixtureWalletMap;
        readonly freezeDay: number;
        readonly tokenUnderlying: Contract;
        readonly oldTwapOracle: MockContract;
        readonly oldAprOracle: MockContract;
        readonly oldPrimaryMarket: MockContract;
        readonly fund: Contract;
        readonly windDown: Contract;
    }

    let basicFixture: Fixture<BasicFixtureData>;
    let integrationFixture: Fixture<IntegrationFixtureData>;
    let delayedSettlementFixture: Fixture<IntegrationFixtureData>;
    let gapIntegrationFixture: Fixture<IntegrationFixtureData>;
    let rebalanceIntegrationFixture: Fixture<IntegrationFixtureData>;
    let wrappedIntegrationFixture: Fixture<IntegrationFixtureData>;

    async function deployBasicFixture(
        _wallets: Wallet[],
        provider: MockProvider
    ): Promise<BasicFixtureData> {
        const [owner, user1] = provider.getWallets();
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        const freezeDay = endOfDay(now + DAY);

        const oldTwapOracle = await deployMockForName(owner, "ITwapOracleV2");
        const oldAprOracle = await deployMockForName(owner, "IAprOracle");
        const fund = await deployMockForName(owner, "FundV3");
        await fund.mock.twapOracle.returns(oldTwapOracle.address);
        await fund.mock.aprOracle.returns(oldAprOracle.address);

        const WindDown = await ethers.getContractFactory("FundV3WindDown");
        const windDown = await WindDown.connect(owner).deploy(fund.address, freezeDay);

        return {
            wallets: { owner, user1 },
            freezeDay,
            fund: fund.address,
            fundMock: fund,
            oldTwapOracle,
            oldAprOracle,
            windDown,
        };
    }

    async function deployPendingIntegrationFixture(
        provider: MockProvider,
        settlementPrice: BigNumber = parseEther("1"),
        freezeDayDelay: number = 0,
        wrappedUnderlying: boolean = false
    ): Promise<IntegrationFixtureData> {
        const [user1, user2, owner, feeCollector] = provider.getWallets();
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await advanceBlockAtTime(endOfDay(now + DAY) - HOUR);

        const oldTwapOracle = await deployMockForName(owner, "ITwapOracleV2");
        await oldTwapOracle.mock.getTwap.returns(settlementPrice);
        await oldTwapOracle.mock.getLatest.returns(parseEther("1"));

        const oldAprOracle = await deployMockForName(owner, "IAprOracle");
        await oldAprOracle.mock.capture.returns(0);

        const ballot = await deployMockForName(owner, "IBallot");
        await ballot.mock.count.returns(0);

        const shareQ = await deployMockForName(owner, "IShareV2");
        const shareB = await deployMockForName(owner, "IShareV2");
        const shareR = await deployMockForName(owner, "IShareV2");
        for (const share of [shareQ, shareB, shareR]) {
            await share.mock.fundEmitTransfer.returns();
            await share.mock.fundEmitApproval.returns();
        }

        const oldPrimaryMarket = await deployMockForName(owner, "IPrimaryMarketV3");
        await oldPrimaryMarket.mock.settle.returns();
        await oldPrimaryMarket.mock.canBeRemovedFromFund.returns(true);

        let tokenUnderlying: Contract;
        if (wrappedUnderlying) {
            const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
            tokenUnderlying = await MockWrappedToken.connect(owner).deploy("Wrapped BNB", "WBNB");
        } else {
            const MockToken = await ethers.getContractFactory("MockToken");
            tokenUnderlying = await MockToken.connect(owner).deploy("Mock BTCB", "BTCB", 18);
        }

        const Fund = await ethers.getContractFactory("FundV3");
        const fund = await Fund.connect(owner).deploy([
            tokenUnderlying.address,
            18,
            shareQ.address,
            shareB.address,
            shareR.address,
            oldPrimaryMarket.address,
            ethers.constants.AddressZero,
            0,
            parseEther("10"),
            parseEther("0.1"),
            oldTwapOracle.address,
            oldAprOracle.address,
            ballot.address,
            feeCollector.address,
        ]);
        await fund.initialize(parseEther("1"), parseEther("1"), parseEther("1"), 0);
        const freezeDay = (await fund.currentDay()).toNumber() + freezeDayDelay;

        const WindDown = await ethers.getContractFactory("FundV3WindDown");
        const windDown = await WindDown.connect(owner).deploy(fund.address, freezeDay);

        if (wrappedUnderlying) {
            await tokenUnderlying.connect(owner).deposit({ value: parseEther("90") });
            await tokenUnderlying.connect(owner).transfer(fund.address, parseEther("90"));
        } else {
            await tokenUnderlying.mint(fund.address, parseEther("90"));
        }
        await oldPrimaryMarket.call(
            fund,
            "primaryMarketMint",
            TRANCHE_Q,
            user1.address,
            parseEther("10"),
            0
        );
        await oldPrimaryMarket.call(
            fund,
            "primaryMarketMint",
            TRANCHE_B,
            user1.address,
            parseEther("20"),
            0
        );
        await oldPrimaryMarket.call(
            fund,
            "primaryMarketMint",
            TRANCHE_R,
            user1.address,
            parseEther("20"),
            0
        );

        await fund.connect(owner).updateTwapOracle(windDown.address);
        await fund.connect(owner).updateAprOracle(windDown.address);
        await fund.connect(owner).updateBallot(windDown.address);
        await fund.connect(owner).proposePrimaryMarketUpdate(windDown.address);

        return {
            wallets: { user1, user2, owner, feeCollector },
            freezeDay,
            tokenUnderlying,
            oldTwapOracle,
            oldAprOracle,
            oldPrimaryMarket,
            fund,
            windDown,
        };
    }

    async function deployIntegrationFixture(
        _wallets: Wallet[],
        provider: MockProvider
    ): Promise<IntegrationFixtureData> {
        const data = await deployPendingIntegrationFixture(provider);

        await advanceBlockAtTime(data.freezeDay + 1);
        await data.fund.settle();

        await advanceBlockAtTime(data.freezeDay + ROLE_UPDATE_MIN_DELAY + 1);
        await data.fund.connect(data.wallets.owner).applyPrimaryMarketUpdate(data.windDown.address);

        return data;
    }

    async function deployDelayedSettlementFixture(
        _wallets: Wallet[],
        provider: MockProvider
    ): Promise<IntegrationFixtureData> {
        const data = await deployPendingIntegrationFixture(provider, parseEther("1"), DAY);

        await advanceBlockAtTime(data.freezeDay + 1);

        return data;
    }

    async function deployGapIntegrationFixture(
        _wallets: Wallet[],
        provider: MockProvider
    ): Promise<IntegrationFixtureData> {
        const data = await deployPendingIntegrationFixture(provider);

        await advanceBlockAtTime(data.freezeDay + 1);
        await data.fund.settle();

        const version = await data.fund.getRebalanceSize();
        await data.oldPrimaryMarket.call(
            data.fund,
            "primaryMarketBurn",
            TRANCHE_Q,
            data.wallets.user1.address,
            parseEther("2"),
            version
        );
        await data.oldPrimaryMarket.call(
            data.fund,
            "primaryMarketMint",
            TRANCHE_B,
            data.wallets.user1.address,
            parseEther("2"),
            version
        );
        await data.oldPrimaryMarket.call(
            data.fund,
            "primaryMarketMint",
            TRANCHE_R,
            data.wallets.user1.address,
            parseEther("2"),
            version
        );
        await data.oldPrimaryMarket.call(
            data.fund,
            "primaryMarketBurn",
            TRANCHE_Q,
            data.wallets.user1.address,
            parseEther("1"),
            version
        );
        await data.oldPrimaryMarket.call(
            data.fund,
            "primaryMarketTransferUnderlying",
            data.wallets.user2.address,
            parseEther("3"),
            0
        );

        await advanceBlockAtTime(data.freezeDay + ROLE_UPDATE_MIN_DELAY + 1);
        await data.fund.connect(data.wallets.owner).applyPrimaryMarketUpdate(data.windDown.address);

        return data;
    }

    async function deployRebalanceIntegrationFixture(
        _wallets: Wallet[],
        provider: MockProvider
    ): Promise<IntegrationFixtureData> {
        const data = await deployPendingIntegrationFixture(provider, parseEther("4"));

        await advanceBlockAtTime(data.freezeDay + 1);
        await expect(() => data.fund.settle()).to.callMocks({
            func: data.oldAprOracle.mock.capture,
            rets: [parseEther("0.05")],
        });

        await advanceBlockAtTime(data.freezeDay + ROLE_UPDATE_MIN_DELAY + 1);
        await data.fund.connect(data.wallets.owner).applyPrimaryMarketUpdate(data.windDown.address);

        return data;
    }

    async function deployWrappedIntegrationFixture(
        _wallets: Wallet[],
        provider: MockProvider
    ): Promise<IntegrationFixtureData> {
        const data = await deployPendingIntegrationFixture(provider, parseEther("1"), 0, true);

        await advanceBlockAtTime(data.freezeDay + 1);
        await data.fund.settle();

        await advanceBlockAtTime(data.freezeDay + ROLE_UPDATE_MIN_DELAY + 1);
        await data.fund.connect(data.wallets.owner).applyPrimaryMarketUpdate(data.windDown.address);

        return data;
    }

    before(function () {
        basicFixture = deployBasicFixture;
        integrationFixture = deployIntegrationFixture;
        delayedSettlementFixture = deployDelayedSettlementFixture;
        gapIntegrationFixture = deployGapIntegrationFixture;
        rebalanceIntegrationFixture = deployRebalanceIntegrationFixture;
        wrappedIntegrationFixture = deployWrappedIntegrationFixture;
    });

    describe("constructor", function () {
        it("Should store immutable configuration", async function () {
            const { freezeDay, fund, oldTwapOracle, oldAprOracle, windDown } = await loadFixture(
                basicFixture
            );

            expect(await windDown.fund()).to.equal(fund);
            expect(await windDown.oldTwapOracle()).to.equal(oldTwapOracle.address);
            expect(await windDown.oldAprOracle()).to.equal(oldAprOracle.address);
            expect(await windDown.freezeDay()).to.equal(freezeDay);
        });

        it("Should require an aligned future freeze day", async function () {
            const { wallets, freezeDay, fund, oldTwapOracle, oldAprOracle } = await loadFixture(
                basicFixture
            );
            const { owner } = wallets;
            const WindDown = await ethers.getContractFactory("FundV3WindDown");

            await expect(
                WindDown.deploy(ethers.constants.AddressZero, freezeDay)
            ).to.be.revertedWith("Zero fund");
            await expect(WindDown.deploy(oldTwapOracle.address, freezeDay + 1)).to.be.revertedWith(
                "Invalid freeze day"
            );

            const fundWithoutTwap = await deployMockForName(owner, "FundV3");
            await fundWithoutTwap.mock.twapOracle.returns(ethers.constants.AddressZero);
            await fundWithoutTwap.mock.aprOracle.returns(oldAprOracle.address);
            await expect(WindDown.deploy(fundWithoutTwap.address, freezeDay)).to.be.revertedWith(
                "Zero TWAP oracle"
            );

            const fundWithoutApr = await deployMockForName(owner, "FundV3");
            await fundWithoutApr.mock.twapOracle.returns(oldTwapOracle.address);
            await fundWithoutApr.mock.aprOracle.returns(ethers.constants.AddressZero);
            await expect(WindDown.deploy(fundWithoutApr.address, freezeDay)).to.be.revertedWith(
                "Zero APR oracle"
            );

            await advanceBlockAtTime(freezeDay + 1);
            await expect(WindDown.deploy(fund, freezeDay)).to.be.revertedWith(
                "Freeze day not future"
            );
        });
    });

    describe("oracle and ballot behavior", function () {
        it("Should delegate TWAP through freeze day and return zero after it", async function () {
            const { freezeDay, oldTwapOracle, windDown } = await loadFixture(basicFixture);
            await oldTwapOracle.mock.getTwap.withArgs(freezeDay - DAY).returns(parseEther("0.9"));
            await oldTwapOracle.mock.getTwap.withArgs(freezeDay).returns(parseEther("1"));

            expect(await windDown.getTwap(freezeDay - DAY)).to.equal(parseEther("0.9"));
            expect(await windDown.getTwap(freezeDay)).to.equal(parseEther("1"));
            expect(await windDown.getTwap(freezeDay + DAY)).to.equal(0);
        });

        it("Should use live latest price before T and frozen TWAP at or after T", async function () {
            const { freezeDay, oldTwapOracle, windDown } = await loadFixture(basicFixture);
            await oldTwapOracle.mock.getLatest.returns(parseEther("1.1"));
            await oldTwapOracle.mock.getTwap.withArgs(freezeDay).returns(parseEther("1"));

            expect(await windDown.getLatest()).to.equal(parseEther("1.1"));

            await advanceBlockAtTime(freezeDay);
            expect(await windDown.getLatest()).to.equal(parseEther("1"));
        });

        it("Should revert if the frozen latest price is not ready", async function () {
            const { freezeDay, oldTwapOracle, windDown } = await loadFixture(basicFixture);
            await oldTwapOracle.mock.getTwap.withArgs(freezeDay).returns(0);

            await advanceBlockAtTime(freezeDay);
            await expect(windDown.getLatest()).to.be.revertedWith("Frozen price not ready");
        });

        it("Should return old APR before T and zero from fund day T while still calling old APR", async function () {
            const { freezeDay, fundMock, oldAprOracle, windDown } = await loadFixture(basicFixture);
            const rate = parseEther("0.001");
            await oldAprOracle.mock.capture.returns(rate);

            expect(await windDown.callStatic.capture()).to.equal(rate);

            await advanceBlockAtTime(freezeDay);
            await fundMock.mock.currentDay.returns(freezeDay - DAY);
            expect(await windDown.callStatic.capture()).to.equal(rate);

            await fundMock.mock.currentDay.returns(freezeDay);
            expect(await windDown.callStatic.capture()).to.equal(0);
        });

        it("Should preserve APR for delayed pre-freeze settlement and freeze day T", async function () {
            const { freezeDay, fund, oldAprOracle } = await loadFixture(delayedSettlementFixture);
            const rate = parseEther("0.001");
            const previousDay = freezeDay - DAY;

            expect(await fund.currentDay()).to.equal(previousDay);
            await expect(() => fund.settle()).to.callMocks({
                func: oldAprOracle.mock.capture,
                rets: [rate],
            });
            expect(await fund.historicalInterestRate(previousDay)).to.equal(rate);
            expect(await fund.currentDay()).to.equal(freezeDay);

            await expect(() => fund.settle()).to.callMocks({
                func: oldAprOracle.mock.capture,
                rets: [rate],
            });
            expect(await fund.historicalInterestRate(freezeDay)).to.equal(0);
            expect(await fund.currentDay()).to.equal(freezeDay + DAY);
        });

        it("Should return zero ballot weight and no-op voting escrow sync", async function () {
            const { windDown } = await loadFixture(basicFixture);

            expect(await windDown.count(123)).to.equal(0);
            await windDown.syncWithVotingEscrow(ethers.constants.AddressZero);
        });
    });

    describe("primary market stubs", function () {
        it("Should expose blocked view stubs", async function () {
            const { windDown } = await loadFixture(basicFixture);

            expect(await windDown.getCreation(1)).to.equal(0);
            await expect(windDown.getCreationForQ(1)).to.be.revertedWith("Wind down");
            await expect(windDown.getRedemption(1)).to.be.revertedWith("Wind down");
            await expect(windDown.getRedemptionForUnderlying(1)).to.be.revertedWith("Wind down");
            expect(await windDown.getSplit(1)).to.equal(0);
            expect(await windDown.getSplitForB(1)).to.equal(0);
            expect(await windDown.getMerge(1)).to.eql([BigNumber.from(0), BigNumber.from(0)]);
            expect(await windDown.getMergeForQ(1)).to.equal(0);
            expect(await windDown.canBeRemovedFromFund()).to.equal(true);
        });

        it("Should block old primary market operations", async function () {
            const { windDown } = await loadFixture(basicFixture);
            const recipient = ethers.constants.AddressZero;

            await expect(windDown.create(recipient, 0, 0)).to.be.revertedWith("Wind down");
            await expect(windDown.redeem(recipient, 1, 0, 0)).to.be.revertedWith("Wind down");
            await expect(windDown.redeemAndUnwrap(recipient, 1, 0, 0)).to.be.revertedWith(
                "Wind down"
            );
            await expect(windDown.queueRedemption(recipient, 1, 0, 0)).to.be.revertedWith(
                "Wind down"
            );
            await expect(windDown.claimRedemptions(recipient, [])).to.be.revertedWith("Wind down");
            await expect(windDown.claimRedemptionsAndUnwrap(recipient, [])).to.be.revertedWith(
                "Wind down"
            );
            await expect(windDown.split(recipient, 1, 0)).to.be.revertedWith("Wind down");
            await expect(windDown.merge(recipient, 1, 0)).to.be.revertedWith("Wind down");
            await windDown.settle(0);
        });

        it("Should hide redemption rates before initialization", async function () {
            const { windDown } = await loadFixture(basicFixture);

            await expect(windDown.underlyingPerQ()).to.be.revertedWith("Not initialized");
            await expect(windDown.underlyingPerB()).to.be.revertedWith("Not initialized");
            await expect(windDown.underlyingPerR()).to.be.revertedWith("Not initialized");
            await expect(windDown.getRedeemAll(ethers.constants.AddressZero)).to.be.revertedWith(
                "Not initialized"
            );
        });

        it("Should enforce readiness before initialization", async function () {
            const { wallets, freezeDay, fundMock, windDown, oldTwapOracle } = await loadFixture(
                basicFixture
            );
            const { user1 } = wallets;

            await fundMock.mock.primaryMarket.returns(ethers.constants.AddressZero);
            await expect(windDown.initialize()).to.be.revertedWith("Not primary market");

            await fundMock.mock.primaryMarket.returns(windDown.address);
            await fundMock.mock.strategy.returns(user1.address);
            await expect(windDown.initialize()).to.be.revertedWith("Strategy not cleared");

            await fundMock.mock.strategy.returns(ethers.constants.AddressZero);
            await fundMock.mock.getStrategyUnderlying.returns(2);
            await expect(windDown.initialize()).to.be.revertedWith(
                "Strategy underlying not cleared"
            );

            await fundMock.mock.getStrategyUnderlying.returns(1);
            await fundMock.mock.getTotalDebt.returns(1);
            await expect(windDown.initialize()).to.be.revertedWith("Debt not cleared");

            await fundMock.mock.getTotalDebt.returns(0);
            await fundMock.mock.currentDay.returns(freezeDay);
            await expect(windDown.initialize()).to.be.revertedWith("Final settlement not done");

            await fundMock.mock.currentDay.returns(freezeDay + DAY);
            await oldTwapOracle.mock.getTwap.withArgs(freezeDay).returns(0);
            await expect(windDown.initialize()).to.be.revertedWith("Frozen price not ready");
        });

        it("Should enforce readiness before activation", async function () {
            const { wallets, freezeDay, fundMock, oldTwapOracle, windDown } = await loadFixture(
                basicFixture
            );
            const { owner, user1 } = wallets;
            const MockToken = await ethers.getContractFactory("MockToken");
            const tokenUnderlying = await MockToken.connect(owner).deploy("Mock BTCB", "BTCB", 18);

            await tokenUnderlying.mint(fundMock.address, parseEther("90"));
            await fundMock.mock.primaryMarket.returns(windDown.address);
            await fundMock.mock.strategy.returns(ethers.constants.AddressZero);
            await fundMock.mock.getStrategyUnderlying.returns(0);
            await fundMock.mock.getTotalDebt.returns(0);
            await fundMock.mock.currentDay.returns(freezeDay + DAY);
            await oldTwapOracle.mock.getTwap.withArgs(freezeDay).returns(parseEther("1"));
            await fundMock.mock.historicalNavs
                .withArgs(freezeDay)
                .returns(parseEther("1"), parseEther("2"));
            await fundMock.mock.splitRatio.returns(parseEther("1"));
            await fundMock.mock.tokenUnderlying.returns(tokenUnderlying.address);
            await fundMock.mock.trancheTotalSupply.withArgs(TRANCHE_Q).returns(parseEther("10"));
            await fundMock.mock.trancheTotalSupply.withArgs(TRANCHE_B).returns(parseEther("20"));
            await fundMock.mock.trancheTotalSupply.withArgs(TRANCHE_R).returns(parseEther("20"));

            await windDown.initialize();

            await fundMock.mock.primaryMarket.returns(ethers.constants.AddressZero);
            await expect(windDown.activate()).to.be.revertedWith("Not primary market");

            await fundMock.mock.primaryMarket.returns(windDown.address);
            await fundMock.mock.strategy.returns(user1.address);
            await expect(windDown.activate()).to.be.revertedWith("Strategy not cleared");

            await fundMock.mock.strategy.returns(ethers.constants.AddressZero);
            await fundMock.mock.getStrategyUnderlying.returns(2);
            await expect(windDown.activate()).to.be.revertedWith("Strategy underlying not cleared");

            await fundMock.mock.getStrategyUnderlying.returns(1);
            await fundMock.mock.getTotalDebt.returns(1);
            await expect(windDown.activate()).to.be.revertedWith("Debt not cleared");
        });
    });

    describe("wind-down redemption", function () {
        it("Should initialize deterministic redemption rates after final settlement and PM apply", async function () {
            const { freezeDay, fund, windDown } = await loadFixture(integrationFixture);

            await expect(windDown.initialize())
                .to.emit(windDown, "Initialized")
                .withArgs(
                    parseEther("1"),
                    parseEther("1"),
                    parseEther("2"),
                    parseEther("1"),
                    parseEther("90"),
                    parseEther("10"),
                    parseEther("20"),
                    parseEther("20")
                );

            expect(await fund.primaryMarket()).to.equal(windDown.address);
            expect(await fund.currentDay()).to.equal(freezeDay + DAY);
            expect(await fund.historicalInterestRate(freezeDay)).to.equal(0);
            expect(await windDown.frozenPrice()).to.equal(parseEther("1"));
            expect(await windDown.frozenNavB()).to.equal(parseEther("1"));
            expect(await windDown.frozenNavR()).to.equal(parseEther("2"));
            expect(await windDown.underlyingPerQ()).to.equal(parseEther("3"));
            expect(await windDown.underlyingPerB()).to.equal(parseEther("1"));
            expect(await windDown.underlyingPerR()).to.equal(parseEther("2"));
            expect(await windDown.active()).to.equal(false);
        });

        it("Should initialize from actual supplies and hot balance after old PM gap actions", async function () {
            const { wallets, freezeDay, tokenUnderlying, fund, windDown } = await loadFixture(
                gapIntegrationFixture
            );
            const { user1, user2 } = wallets;

            expect(await tokenUnderlying.balanceOf(fund.address)).to.equal(parseEther("87"));
            expect(await tokenUnderlying.balanceOf(user2.address)).to.equal(parseEther("3"));
            await expect(windDown.initialize())
                .to.emit(windDown, "Initialized")
                .withArgs(
                    parseEther("1"),
                    parseEther("1"),
                    parseEther("2"),
                    parseEther("1"),
                    parseEther("87"),
                    parseEther("7"),
                    parseEther("22"),
                    parseEther("22")
                );

            expect(await fund.currentDay()).to.equal(freezeDay + DAY);
            expect(await windDown.underlyingPerQ()).to.equal(parseEther("3"));
            expect(await windDown.underlyingPerB()).to.equal(parseEther("1"));
            expect(await windDown.underlyingPerR()).to.equal(parseEther("2"));
            expect(await windDown.getRedeemAll(user1.address)).to.equal(parseEther("87"));
        });

        it("Should initialize after a final-settlement rebalance and block later settlement", async function () {
            const { freezeDay, fund, windDown } = await loadFixture(rebalanceIntegrationFixture);

            expect(await fund.getRebalanceSize()).to.equal(1);
            expect(await fund.currentDay()).to.equal(freezeDay + DAY);
            expect(await fund.historicalInterestRate(freezeDay)).to.equal(0);

            const navs = await fund.historicalNavs(freezeDay);
            expect(navs.navB).to.equal(parseEther("1"));
            expect(navs.navR).to.equal(parseEther("1"));

            await expect(fund.settle()).to.be.revertedWith(
                "Underlying price for settlement is not ready yet"
            );

            await windDown.initialize();
            expect(await windDown.frozenPrice()).to.equal(parseEther("4"));
            expect(await windDown.frozenNavB()).to.equal(parseEther("1"));
            expect(await windDown.frozenNavR()).to.equal(parseEther("1"));
            expect(await windDown.frozenSplitRatio()).to.equal(parseEther("6"));
            expect(await windDown.getLatest()).to.equal(parseEther("4"));
        });

        it("Should redeem stale user balances after a final-settlement rebalance", async function () {
            const { wallets, tokenUnderlying, fund, windDown } = await loadFixture(
                rebalanceIntegrationFixture
            );
            const { user1, user2 } = wallets;

            expect(await fund.getRebalanceSize()).to.equal(1);
            expect(await fund.trancheBalanceVersion(user1.address)).to.equal(0);

            await windDown.initialize();
            await windDown.activate();

            const expectedUnderlying = await windDown.getRedeemAll(user1.address);
            expect(expectedUnderlying.gt(0)).to.equal(true);

            const fundBalanceBefore = await tokenUnderlying.balanceOf(fund.address);
            const user2BalanceBefore = await tokenUnderlying.balanceOf(user2.address);
            await windDown.connect(user1).redeemAll(user2.address, expectedUnderlying);

            expect(await fund.trancheBalanceVersion(user1.address)).to.equal(1);
            expect(await tokenUnderlying.balanceOf(fund.address)).to.equal(
                fundBalanceBefore.sub(expectedUnderlying)
            );
            expect(await tokenUnderlying.balanceOf(user2.address)).to.equal(
                user2BalanceBefore.add(expectedUnderlying)
            );
            expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(0);
            expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(0);
            expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(0);
        });

        it("Should require owner-only initialization and activation", async function () {
            const { wallets, windDown } = await loadFixture(integrationFixture);
            const { user1 } = wallets;

            await expect(windDown.connect(user1).initialize()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
            await windDown.initialize();
            await expect(windDown.connect(user1).activate()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
            await windDown.activate();
            await expect(windDown.connect(user1).deactivate()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should enforce one-shot initialization and active state guards", async function () {
            const { windDown } = await loadFixture(integrationFixture);

            await expect(windDown.deactivate()).to.be.revertedWith("Not active");

            await windDown.initialize();
            await expect(windDown.initialize()).to.be.revertedWith("Already initialized");

            await windDown.activate();
            await expect(windDown.activate()).to.be.revertedWith("Already active");

            await windDown.deactivate();
            await expect(windDown.deactivate()).to.be.revertedWith("Not active");
            await expect(windDown.activate()).to.emit(windDown, "Activated");
        });

        it("Should activate, deactivate, and require active redemptions", async function () {
            const { wallets, windDown } = await loadFixture(integrationFixture);
            const { user1, user2 } = wallets;

            await windDown.initialize();
            await expect(windDown.connect(user1).redeemAll(user2.address, 0)).to.be.revertedWith(
                "Not active"
            );
            await expect(
                windDown.connect(user1).redeemAllAndUnwrap(user2.address, 0)
            ).to.be.revertedWith("Not active");

            await expect(windDown.activate()).to.emit(windDown, "Activated");
            expect(await windDown.active()).to.equal(true);
            await expect(windDown.deactivate()).to.emit(windDown, "Deactivated");
            expect(await windDown.active()).to.equal(false);
            await expect(windDown.connect(user1).redeemAll(user2.address, 0)).to.be.revertedWith(
                "Not active"
            );
            await expect(
                windDown.connect(user1).redeemAllAndUnwrap(user2.address, 0)
            ).to.be.revertedWith("Not active");
        });

        it("Should reject activation when fund balance cannot cover outstanding redemptions", async function () {
            const { wallets, tokenUnderlying, fund, windDown } = await loadFixture(
                integrationFixture
            );
            const { owner } = wallets;

            await windDown.initialize();
            await tokenUnderlying.connect(owner).burn(fund.address, 1);

            await expect(windDown.activate()).to.be.revertedWith("Insufficient underlying");
        });

        it("Should redeem all latest-version Q/B/R at fixed rates", async function () {
            const { wallets, tokenUnderlying, fund, windDown } = await loadFixture(
                integrationFixture
            );
            const { user1, user2 } = wallets;
            const expectedUnderlying = parseEther("90");

            await windDown.initialize();
            await windDown.activate();

            expect(await windDown.getRedeemAll(user1.address)).to.equal(expectedUnderlying);
            await expect(
                windDown.connect(user1).redeemAll(user2.address, expectedUnderlying.add(1))
            ).to.be.revertedWith("Min underlying redeemed");

            const fundBalanceBefore = await tokenUnderlying.balanceOf(fund.address);
            const user2BalanceBefore = await tokenUnderlying.balanceOf(user2.address);
            const tx = await windDown.connect(user1).redeemAll(user2.address, expectedUnderlying);
            await expect(tx)
                .to.emit(windDown, "RedeemedAll")
                .withArgs(
                    user1.address,
                    user2.address,
                    parseEther("10"),
                    parseEther("20"),
                    parseEther("20"),
                    expectedUnderlying
                );
            expect(await tokenUnderlying.balanceOf(fund.address)).to.equal(
                fundBalanceBefore.sub(expectedUnderlying)
            );
            expect(await tokenUnderlying.balanceOf(user2.address)).to.equal(
                user2BalanceBefore.add(expectedUnderlying)
            );

            expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(0);
            expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(0);
            expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(0);
            expect(await windDown.getRedeemAll(user1.address)).to.equal(0);
        });

        it("Should redeem all latest-version Q/B/R and unwrap native underlying", async function () {
            const { wallets, tokenUnderlying, fund, windDown } = await loadFixture(
                wrappedIntegrationFixture
            );
            const { user1, user2 } = wallets;
            const expectedUnderlying = parseEther("90");

            await windDown.initialize();
            await windDown.activate();

            expect(
                await windDown
                    .connect(user1)
                    .callStatic.redeemAllAndUnwrap(user2.address, expectedUnderlying)
            ).to.equal(expectedUnderlying);

            const user2BalanceBefore = await ethers.provider.getBalance(user2.address);
            const tx = await windDown
                .connect(user1)
                .redeemAllAndUnwrap(user2.address, expectedUnderlying);
            await expect(tx)
                .to.emit(windDown, "RedeemedAll")
                .withArgs(
                    user1.address,
                    user2.address,
                    parseEther("10"),
                    parseEther("20"),
                    parseEther("20"),
                    expectedUnderlying
                );

            expect(await ethers.provider.getBalance(user2.address)).to.equal(
                user2BalanceBefore.add(expectedUnderlying)
            );
            expect(await tokenUnderlying.balanceOf(fund.address)).to.equal(0);
            expect(await tokenUnderlying.balanceOf(windDown.address)).to.equal(0);
            expect(await windDown.getRedeemAll(user1.address)).to.equal(0);
        });

        it("Should reactivate after partial redemptions using current outstanding supply", async function () {
            const { wallets, tokenUnderlying, fund, windDown } = await loadFixture(
                integrationFixture
            );
            const { user1, user2 } = wallets;
            const version = await fund.getRebalanceSize();
            const expectedHalfUnderlying = parseEther("45");

            await fund
                .connect(user1)
                .trancheTransfer(TRANCHE_Q, user2.address, parseEther("5"), version);
            await fund
                .connect(user1)
                .trancheTransfer(TRANCHE_B, user2.address, parseEther("10"), version);
            await fund
                .connect(user1)
                .trancheTransfer(TRANCHE_R, user2.address, parseEther("10"), version);

            await windDown.initialize();
            await windDown.activate();

            await windDown.connect(user1).redeemAll(user1.address, expectedHalfUnderlying);
            expect(await tokenUnderlying.balanceOf(fund.address)).to.equal(expectedHalfUnderlying);

            await windDown.deactivate();
            await expect(windDown.activate()).to.emit(windDown, "Activated");

            await windDown.connect(user2).redeemAll(user2.address, expectedHalfUnderlying);
            expect(await tokenUnderlying.balanceOf(fund.address)).to.equal(0);
        });

        it("Should keep fixed-rate redemption order-independent with rounding dust", async function () {
            async function prepareRoundingScenario() {
                const data = await loadFixture(integrationFixture);
                const { user1, user2, owner } = data.wallets;
                const version = await data.fund.getRebalanceSize();

                await data.fund
                    .connect(user1)
                    .trancheTransfer(TRANCHE_Q, user2.address, parseEther("3"), version);
                await data.fund
                    .connect(user1)
                    .trancheTransfer(TRANCHE_B, user2.address, parseEther("7"), version);
                await data.fund
                    .connect(user1)
                    .trancheTransfer(TRANCHE_R, user2.address, parseEther("11"), version);
                await data.tokenUnderlying.connect(owner).mint(data.fund.address, parseEther("1"));

                await data.windDown.initialize();
                const expectedUser1 = await data.windDown.getRedeemAll(user1.address);
                const expectedUser2 = await data.windDown.getRedeemAll(user2.address);
                const initialFundBalance = await data.tokenUnderlying.balanceOf(data.fund.address);
                await data.windDown.activate();

                return { ...data, expectedUser1, expectedUser2, initialFundBalance };
            }

            const first = await prepareRoundingScenario();
            await first.windDown
                .connect(first.wallets.user1)
                .redeemAll(first.wallets.user1.address, 0);
            await first.windDown
                .connect(first.wallets.user2)
                .redeemAll(first.wallets.user2.address, 0);

            const firstDust = first.initialFundBalance
                .sub(first.expectedUser1)
                .sub(first.expectedUser2);
            expect(firstDust.toNumber()).to.be.greaterThan(0);
            expect(firstDust.toNumber()).to.be.lessThan(20);
            expect(await first.tokenUnderlying.balanceOf(first.wallets.user1.address)).to.equal(
                first.expectedUser1
            );
            expect(await first.tokenUnderlying.balanceOf(first.wallets.user2.address)).to.equal(
                first.expectedUser2
            );
            expect(await first.tokenUnderlying.balanceOf(first.fund.address)).to.equal(firstDust);

            const second = await prepareRoundingScenario();
            await second.windDown
                .connect(second.wallets.user2)
                .redeemAll(second.wallets.user2.address, 0);
            await second.windDown
                .connect(second.wallets.user1)
                .redeemAll(second.wallets.user1.address, 0);

            const secondDust = second.initialFundBalance
                .sub(second.expectedUser1)
                .sub(second.expectedUser2);
            expect(secondDust).to.equal(firstDust);
            expect(await second.tokenUnderlying.balanceOf(second.wallets.user1.address)).to.equal(
                second.expectedUser1
            );
            expect(await second.tokenUnderlying.balanceOf(second.wallets.user2.address)).to.equal(
                second.expectedUser2
            );
            expect(await second.tokenUnderlying.balanceOf(second.fund.address)).to.equal(
                secondDust
            );
        });

        it("Should return initialized frozen price from getLatest", async function () {
            const { freezeDay, oldTwapOracle, windDown } = await loadFixture(integrationFixture);
            await windDown.initialize();
            await oldTwapOracle.mock.getTwap.withArgs(freezeDay).returns(parseEther("2"));

            expect(await windDown.getLatest()).to.equal(parseEther("1"));
        });
    });
});
