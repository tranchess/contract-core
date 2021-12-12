import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider, Stub } from "ethereum-waffle";
import hre = require("hardhat");
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import {
    TRANCHE_M,
    TRANCHE_A,
    TRANCHE_B,
    DAY,
    HOUR,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";

const TOKEN_HUB_ADDR = "0x0000000000000000000000000000000000001004";
const PERFORMANCE_FEE_BPS = 2000; // 20%

describe("BscStakingStrategy", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startDay: number;
        readonly wbnb: Contract;
        readonly fund: MockContract;
        readonly strategy: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let reporter: Wallet;
    let staker: Wallet;
    let owner: Wallet;
    let startDay: number;
    let wbnb: Contract;
    let fund: MockContract;
    let strategy: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, reporter, staker, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startDay = Math.ceil(startTimestamp / DAY) * DAY + DAY + SETTLEMENT_TIME;
        await advanceBlockAtTime(startDay - DAY / 2);

        const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
        const wbnb = await MockWrappedToken.connect(owner).deploy("Wrapped BNB", "WBNB");

        const fund = await deployMockForName(owner, "FundV2");
        await fund.mock.tokenUnderlying.returns(wbnb.address);

        const BscStakingStrategy = await ethers.getContractFactory("BscStakingStrategy");
        const strategy = await BscStakingStrategy.connect(owner).deploy(
            fund.address,
            staker.address,
            parseEther("0.0001").mul(PERFORMANCE_FEE_BPS)
        );

        await hre.run("dev_deploy_token_hub");

        return {
            wallets: { user1, reporter, staker, owner },
            startDay,
            wbnb,
            fund,
            strategy: strategy.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        reporter = fixtureData.wallets.reporter;
        staker = fixtureData.wallets.staker;
        owner = fixtureData.wallets.owner;
        startDay = fixtureData.startDay;
        wbnb = fixtureData.wbnb;
        fund = fixtureData.fund;
        strategy = fixtureData.strategy;
    });

    describe("transferToStaker()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.transferToStaker(parseEther("1"))).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should transfer to TokenHub", async function () {
            await fund.mock.transferToStrategy.returns();
            await wbnb.deposit({ value: parseEther("1") });
            await wbnb.transfer(strategy.address, parseEther("1"));
            await strategy.connect(owner).transferToStaker(parseEther("1"));
            expect(await wbnb.balanceOf(strategy.address)).to.equal(0);
            expect(await ethers.provider.getBalance(TOKEN_HUB_ADDR)).to.equal(parseEther("1"));
        });
    });

    describe("transferToFund()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.transferToFund()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should transfer native currency to fund", async function () {
            await owner.sendTransaction({ to: strategy.address, value: parseEther("1") });
            await expect(() => strategy.connect(owner).transferToFund()).to.callMocks({
                func: fund.mock.transferFromStrategy.withArgs(parseEther("1")),
            });
            expect(await wbnb.allowance(strategy.address, fund.address)).to.equal(parseEther("1"));
        });

        it("Should transfer wrapped tokens to fund", async function () {
            await wbnb.deposit({ value: parseEther("2") });
            await wbnb.transfer(strategy.address, parseEther("2"));
            await expect(() => strategy.connect(owner).transferToFund()).to.callMocks({
                func: fund.mock.transferFromStrategy.withArgs(parseEther("2")),
            });
            expect(await wbnb.allowance(strategy.address, fund.address)).to.equal(parseEther("2"));
        });

        it("Should transfer both to fund", async function () {
            await owner.sendTransaction({ to: strategy.address, value: parseEther("3") });
            await wbnb.deposit({ value: parseEther("4") });
            await wbnb.transfer(strategy.address, parseEther("4"));
            await expect(() => strategy.connect(owner).transferToFund()).to.callMocks({
                func: fund.mock.transferFromStrategy.withArgs(parseEther("7")),
            });
            expect(await wbnb.allowance(strategy.address, fund.address)).to.equal(parseEther("7"));
        });
    });

    describe("reportProfit()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.reportProfit(parseEther("1"))).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should report to fund", async function () {
            await fund.mock.currentDay.returns(startDay);
            const profit = parseEther("1");
            const performanceFee = profit.mul(PERFORMANCE_FEE_BPS).div(10000);
            await expect(() => strategy.connect(owner).reportProfit(profit)).to.callMocks({
                func: fund.mock.reportProfit.withArgs(profit, performanceFee),
            });
        });

        it("Should update reported day", async function () {
            await fund.mock.currentDay.returns(startDay + DAY * 10);
            await fund.mock.reportProfit.returns();
            await strategy.connect(owner).reportProfit(parseEther("1"));
            expect(await strategy.reportedDay()).to.equal(startDay + DAY * 10);
        });
    });

    describe("reportLoss()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.reportLoss(parseEther("1"))).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should report to fund", async function () {
            await fund.mock.currentDay.returns(startDay);
            await expect(() => strategy.connect(owner).reportLoss(parseEther("1"))).to.callMocks({
                func: fund.mock.reportLoss.withArgs(parseEther("1")),
            });
        });

        it("Should update reported day", async function () {
            await fund.mock.currentDay.returns(startDay + DAY * 10);
            await fund.mock.reportLoss.returns();
            await strategy.connect(owner).reportLoss(parseEther("1"));
            expect(await strategy.reportedDay()).to.equal(startDay + DAY * 10);
        });

        it("Should cumulate drawdown", async function () {
            await fund.mock.currentDay.returns(startDay);
            await fund.mock.reportLoss.returns();
            await strategy.connect(owner).reportLoss(parseEther("2"));
            expect(await strategy.currentDrawdown()).to.equal(parseEther("2"));
            await strategy.connect(owner).reportLoss(parseEther("3"));
            expect(await strategy.currentDrawdown()).to.equal(parseEther("5"));
        });

        it("Should only charge performance fee when drawdown is zero", async function () {
            await fund.mock.currentDay.returns(startDay);
            await fund.mock.reportLoss.returns();
            await strategy.connect(owner).reportLoss(parseEther("5"));
            await expect(() => strategy.connect(owner).reportProfit(parseEther("3"))).to.callMocks({
                func: fund.mock.reportProfit.withArgs(parseEther("3"), 0),
            });
            expect(await strategy.currentDrawdown()).to.equal(parseEther("2"));
            const performanceFee = parseEther("2").mul(PERFORMANCE_FEE_BPS).div(10000);
            await expect(() => strategy.connect(owner).reportProfit(parseEther("4"))).to.callMocks({
                func: fund.mock.reportProfit.withArgs(parseEther("4"), performanceFee),
            });
            expect(await strategy.currentDrawdown()).to.equal(parseEther("0"));
        });
    });

    describe("updateStaker", async function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.updateStaker(user1.address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should reject zero address", async function () {
            await expect(strategy.connect(owner).updateStaker(ethers.constants.AddressZero)).to.be
                .reverted;
        });

        it("Should update staker", async function () {
            expect(await strategy.staker()).to.equal(staker.address);
            await expect(strategy.connect(owner).updateStaker(user1.address))
                .to.emit(strategy, "StakerUpdated")
                .withArgs(user1.address);
            expect(await strategy.staker()).to.equal(user1.address);
        });
    });

    describe("updateEstimatedDailyProfitRate()", async function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.updateEstimatedDailyProfitRate(0)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should reject rate exceeding the limit", async function () {
            await expect(strategy.connect(owner).updateEstimatedDailyProfitRate(parseEther("1"))).to
                .be.reverted;
        });

        it("Should update the rate and reported day", async function () {
            await fund.mock.currentDay.returns(startDay + DAY * 10);
            await strategy.connect(owner).updateEstimatedDailyProfitRate(parseEther("0.01"));
            expect(await strategy.estimatedDailyProfitRate()).to.equal(parseEther("0.01"));
            expect(await strategy.reportedDay()).to.equal(startDay + DAY * 10);
        });
    });

    describe("updatePerformanceFeeRate()", async function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.updatePerformanceFeeRate(0)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should reject rate exceeding the limit", async function () {
            await expect(strategy.connect(owner).updatePerformanceFeeRate(parseEther("1"))).to.be
                .reverted;
        });

        it("Should update the rate ", async function () {
            await strategy.connect(owner).updatePerformanceFeeRate(parseEther("0.1"));
            expect(await strategy.performanceFeeRate()).to.equal(parseEther("0.1"));
        });
    });

    describe("addReporter()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.addReporter(user1.address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should add reporter", async function () {
            await expect(strategy.connect(owner).addReporter(reporter.address))
                .to.emit(strategy, "ReporterAdded")
                .withArgs(reporter.address);
            expect(await strategy.reporters(reporter.address)).to.equal(true);
        });

        it("Should revert when adding existing reporter", async function () {
            await strategy.connect(owner).addReporter(reporter.address);
            await expect(strategy.connect(owner).addReporter(reporter.address)).to.be.reverted;
        });
    });

    describe("removeReporter()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(strategy.removeReporter(user1.address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should remove reporter", async function () {
            await strategy.connect(owner).addReporter(reporter.address);
            await expect(strategy.connect(owner).removeReporter(reporter.address))
                .to.emit(strategy, "ReporterRemoved")
                .withArgs(reporter.address);
            expect(await strategy.reporters(reporter.address)).to.equal(false);
        });

        it("Should revert when removing non-existing reporter", async function () {
            await expect(strategy.connect(owner).removeReporter(reporter.address)).to.be.reverted;
        });
    });

    describe("accrueProfit() and accrueEstimatedProfit()", function () {
        const estimatedProfit = parseEther("500");
        const estimatedFee = estimatedProfit.mul(PERFORMANCE_FEE_BPS).div(10000);

        beforeEach(async function () {
            await fund.mock.getStrategyUnderlying.returns(parseEther("50000"));
            await fund.mock.currentDay.returns(startDay);
            await strategy.connect(owner).addReporter(reporter.address);
            await strategy.connect(owner).updateEstimatedDailyProfitRate(parseEther("0.01"));
            strategy = strategy.connect(reporter);
        });

        it("Should revert if not called by reporter", async function () {
            await expect(strategy.connect(user1).accrueProfit(parseEther("1"))).to.be.revertedWith(
                "Only reporter"
            );
            await expect(strategy.connect(user1).accrueEstimatedProfit()).to.be.revertedWith(
                "Only reporter"
            );
        });

        it("Should not exceed twice the estimation", async function () {
            await fund.mock.currentDay.returns(startDay + DAY);
            await expect(strategy.accrueProfit(estimatedProfit.mul(3))).to.be.revertedWith(
                "Profit out of range"
            );
        });

        it("Should not accrue multiple times for a day", async function () {
            await fund.mock.reportProfit.returns();
            await fund.mock.currentDay.returns(startDay + DAY);
            await strategy.accrueProfit(parseEther("1"));
            expect(await strategy.reportedDay()).to.equal(startDay + DAY);
            await expect(strategy.accrueProfit(parseEther("1"))).to.be.revertedWith(
                "Already reported"
            );
            await fund.mock.currentDay.returns(startDay + DAY * 3);
            await strategy.accrueEstimatedProfit();
            await strategy.accrueEstimatedProfit();
            expect(await strategy.reportedDay()).to.equal(startDay + DAY * 3);
            await expect(strategy.accrueEstimatedProfit()).to.be.revertedWith("Already reported");
        });

        it("Should report to fund", async function () {
            await fund.mock.currentDay.returns(startDay + DAY * 10);
            await expect(() => strategy.accrueEstimatedProfit()).to.callMocks({
                func: fund.mock.reportProfit.withArgs(estimatedProfit, estimatedFee),
            });
            await expect(() => strategy.accrueProfit(estimatedProfit.div(2))).to.callMocks({
                func: fund.mock.reportProfit.withArgs(estimatedProfit.div(2), estimatedFee.div(2)),
            });
        });

        it("Should consider current drawdown in charging performance fee", async function () {
            await fund.mock.reportLoss.returns();
            await strategy.connect(owner).reportLoss(estimatedProfit.div(10));
            await fund.mock.currentDay.returns(startDay + DAY * 10);
            await expect(() => strategy.accrueEstimatedProfit()).to.callMocks({
                func: fund.mock.reportProfit.withArgs(estimatedProfit, estimatedFee.mul(9).div(10)),
            });
            expect(await strategy.currentDrawdown()).to.equal(0);

            await strategy.connect(owner).reportLoss(estimatedProfit.div(4));
            await fund.mock.currentDay.returns(startDay + DAY * 20);
            await expect(() => strategy.accrueProfit(estimatedProfit.div(2))).to.callMocks({
                func: fund.mock.reportProfit.withArgs(estimatedProfit.div(2), estimatedFee.div(4)),
            });
            expect(await strategy.currentDrawdown()).to.equal(0);
        });
    });

    describe("receive()", function () {
        it("Should emit event with source address", async function () {
            await expect(user1.sendTransaction({ to: strategy.address, value: parseEther("1") }))
                .to.emit(strategy, "Received")
                .withArgs(user1.address, parseEther("1"));
        });
    });
});
