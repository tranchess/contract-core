import { expect } from "chai";
import { BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import {
    TRANCHE_Q,
    DAY,
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
    setAutomine,
} from "./utils";

const UPPER_REBALANCE_THRESHOLD = parseEther("2");
const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");

describe("InterestRateBallotV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly twapOracle: MockContract;
        readonly btc: Contract;
        readonly aprOracle: MockContract;
        readonly primaryMarket: MockContract;
        readonly votingEscrow: MockContract;
        readonly ballot: Contract;
        readonly fund: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let strategy: Wallet;
    let addr1: string;
    let addr2: string;
    let twapOracle: MockContract;
    let btc: Contract;
    let aprOracle: MockContract;
    let primaryMarket: MockContract;
    let votingEscrow: MockContract;
    let ballot: Contract;
    let fund: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        await advanceBlockAtTime(startWeek - DAY * 2);

        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        await twapOracle.mock.getTwap.returns(parseEther("1000"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        await btc.mint(user1.address, parseBtc("10000"));
        await btc.mint(user2.address, parseBtc("10000"));

        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(0);

        const shareQ = await deployMockForName(owner, "IShareV2");
        const shareB = await deployMockForName(owner, "IShareV2");
        const shareR = await deployMockForName(owner, "IShareV2");
        for (const share of [shareQ, shareB, shareR]) {
            await share.mock.fundEmitTransfer.returns();
            await share.mock.fundEmitApproval.returns();
        }
        const primaryMarket = await deployMockForName(owner, "IPrimaryMarketV3");
        await primaryMarket.mock.settle.returns();

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.maxTime.returns(WEEK * 200);
        const InterestRateBallotV2 = await ethers.getContractFactory("InterestRateBallotV2");
        const ballot = await InterestRateBallotV2.deploy(votingEscrow.address);

        const Fund = await ethers.getContractFactory("FundV3");
        const fund = await Fund.connect(owner).deploy([
            btc.address,
            8,
            shareQ.address,
            shareB.address,
            shareR.address,
            primaryMarket.address,
            ethers.constants.AddressZero,
            0,
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            ballot.address,
            feeCollector.address,
        ]);
        await fund.initialize(parseEther("500"), parseEther("1"), parseEther("1"), 0);

        // Create 1 QUEEN for user1
        await btc.mint(fund.address, parseBtc("1"));
        await primaryMarket.call(
            fund,
            "primaryMarketMint",
            TRANCHE_Q,
            user1.address,
            parseEther("1"),
            0
        );

        return {
            wallets: { user1, user2, owner, strategy },
            startWeek,
            twapOracle,
            btc,
            aprOracle,
            primaryMarket,
            votingEscrow,
            ballot,
            fund: fund.connect(user1),
        };
    }

    async function pmCreate(
        account: string,
        inBtc: BigNumberish,
        outQ: BigNumberish
    ): Promise<void> {
        await btc.mint(fund.address, inBtc);
        await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_Q, account, outQ, 0);
    }

    async function pmRedeem(
        account: string,
        inQ: BigNumberish,
        outBtc: BigNumberish
    ): Promise<void> {
        await btc.burn(fund.address, outBtc);
        await primaryMarket.call(fund, "primaryMarketBurn", TRANCHE_Q, account, inQ, 0);
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        owner = fixtureData.wallets.owner;
        strategy = fixtureData.wallets.strategy;
        addr1 = user1.address;
        addr2 = user2.address;
        startWeek = fixtureData.startWeek;
        twapOracle = fixtureData.twapOracle;
        btc = fixtureData.btc;
        aprOracle = fixtureData.aprOracle;
        primaryMarket = fixtureData.primaryMarket;
        votingEscrow = fixtureData.votingEscrow;
        ballot = fixtureData.ballot;
        fund = fixtureData.fund;
    });

    describe("cast()", function () {
        it("Should reject invalid weight", async function () {
            await expect(ballot.cast(parseEther("1.01"))).to.be.revertedWith("Invalid weight");
        });

        it("Should reject vote with no veCHESS", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([0, startWeek + WEEK * 10]);
            await expect(ballot.cast(parseEther("1"))).to.be.revertedWith("No veCHESS");
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek - WEEK]);
            await expect(ballot.cast(parseEther("1"))).to.be.revertedWith("No veCHESS");
        });

        it("Should cast vote", async function () {
            const amount = parseEther("40");
            const unlockTime = startWeek + WEEK * 50;
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unlockTime]);

            await setNextBlockTime(startWeek);
            await ballot.cast(parseEther("0.7"));
            const voter = await ballot.voters(addr1);
            expect(voter.amount).to.equal(amount);
            expect(voter.unlockTime).to.equal(unlockTime);
            expect(voter.weight).to.equal(parseEther("0.7"));
        });

        it("Should change the vote", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("40"), startWeek + WEEK * 50]);
            await ballot.cast(parseEther("0.7"));
            const amount = parseEther("80");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unlockTime]);

            await setNextBlockTime(startWeek);
            await ballot.cast(parseEther("0.9"));
            const voter = await ballot.voters(addr1);
            expect(voter.amount).to.equal(amount);
            expect(voter.unlockTime).to.equal(unlockTime);
            expect(voter.weight).to.equal(parseEther("0.9"));
        });

        it("Should update the result", async function () {
            const w50 = startWeek + WEEK * 50;
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("40"), w50]);
            await ballot.cast(parseEther("0.7"));
            expect(await ballot.weightedScheduledUnlock(w50)).to.equal(
                parseEther("40").mul(parseEther("0.7"))
            );
            expect(await ballot.totalSupplyAtWeek(startWeek)).to.equal(parseEther("10"));
            expect(await ballot.averageAtWeek(startWeek)).to.equal(parseEther("0.7"));

            const w100 = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr2)
                .returns([parseEther("80"), w100]);
            await ballot.connect(user2).cast(parseEther("0.9"));
            expect(await ballot.weightedScheduledUnlock(w100)).to.equal(
                parseEther("80").mul(parseEther("0.9"))
            );
            expect(await ballot.totalSupplyAtWeek(startWeek)).to.equal(parseEther("50"));
            expect(await ballot.averageAtWeek(startWeek)).to.equal(parseEther("0.86"));
        });

        it("Should emit event", async function () {
            const amount1 = parseEther("1");
            const unlockTime1 = startWeek + WEEK * 10;
            const weight1 = parseEther("0.7");
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([amount1, unlockTime1]);
            await expect(ballot.cast(weight1))
                .to.emit(ballot, "Voted")
                .withArgs(addr1, 0, 0, 0, amount1, unlockTime1, weight1);

            const amount2 = parseEther("10");
            const unlockTime2 = startWeek + WEEK * 100;
            const weight2 = parseEther("0.9");
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([amount2, unlockTime2]);
            await expect(ballot.cast(weight2))
                .to.emit(ballot, "Voted")
                .withArgs(addr1, amount1, unlockTime1, weight1, amount2, unlockTime2, weight2);
        });
    });

    describe("syncWithVotingEscrow()", function () {
        it("Should do nothing if the user did not vote before", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek + WEEK * 10]);
            await ballot.syncWithVotingEscrow(addr1);
            expect(await ballot.averageAtWeek(startWeek)).to.equal(parseEther("0.5"));
            const voter = await ballot.voters(addr1);
            expect(voter.amount).to.equal(0);
            expect(voter.unlockTime).to.equal(0);
            expect(voter.weight).to.equal(0);
        });

        it("Should do nothing if the user owns no veCHESS", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("10"), startWeek + WEEK * 10]);
            await ballot.cast(parseEther("0.7"));
            await advanceBlockAtTime(startWeek + WEEK * 20);
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("20"), startWeek + WEEK * 15]);
            await ballot.syncWithVotingEscrow(addr1);
            expect(await ballot.averageAtWeek(startWeek + WEEK * 20)).to.equal(parseEther("0.5"));
            const voter = await ballot.voters(addr1);
            expect(voter.amount).to.equal(parseEther("10"));
            expect(voter.unlockTime).to.equal(startWeek + WEEK * 10);
            expect(voter.weight).to.equal(parseEther("0.7"));
        });

        it("Should update the vote", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("40"), startWeek + WEEK * 50]);
            await ballot.cast(parseEther("0.7"));
            const amount = parseEther("80");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unlockTime]);

            await setNextBlockTime(startWeek);
            await ballot.syncWithVotingEscrow(addr1);
            const voter = await ballot.voters(addr1);
            expect(voter.amount).to.equal(amount);
            expect(voter.unlockTime).to.equal(unlockTime);
            expect(voter.weight).to.equal(parseEther("0.7"));
        });
    });

    describe("getFundRelativeIncome()", function () {
        it("Should return zero if the parameter is an EOA", async function () {
            const ret = await ballot.getFundRelativeIncome(addr1);
            expect(ret.incomeOverQ).to.equal(0);
            expect(ret.incomeOverB).to.equal(0);
        });

        it("Should return zero if the parameter is a non-fund contract", async function () {
            const ret = await ballot.getFundRelativeIncome(votingEscrow.address);
            expect(ret.incomeOverQ).to.equal(0);
            expect(ret.incomeOverB).to.equal(0);
        });

        it("Should return zero if the fund is not initialized", async function () {
            const uninitializedFund = await deployMockForName(owner, "IFundV3");
            await uninitializedFund.mock.currentDay.returns(0);
            const ret = await ballot.getFundRelativeIncome(uninitializedFund.address);
            expect(ret.incomeOverQ).to.equal(0);
            expect(ret.incomeOverB).to.equal(0);
        });

        it("Should return zero if the fund was just rebalanced in the same block", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("2500"));
            await advanceBlockAtTime(startWeek - DAY);
            await setAutomine(false);
            await fund.settle();
            await setAutomine(true);
            // This tx and the last settlement are in the same block
            await btc.mint(fund.address, parseBtc("0.5"));
            const ret = await ballot.getFundRelativeIncome(fund.address);
            expect(ret.incomeOverQ).to.equal(0);
            expect(ret.incomeOverB).to.equal(0);
        });

        it("Should return zero if the fund was empty at the last settlement", async function () {
            await btc.mint(fund.address, parseBtc("0.5"));
            const ret = await ballot.getFundRelativeIncome(fund.address);
            expect(ret.incomeOverQ).to.equal(0);
            expect(ret.incomeOverB).to.equal(0);
        });

        it("Should return zero if the fund is empty now", async function () {
            await advanceBlockAtTime(startWeek - DAY);
            await fund.settle();
            await pmRedeem(addr1, parseEther("1"), parseBtc("1"));
            await btc.mint(fund.address, parseBtc("0.1"));
            const ret = await ballot.getFundRelativeIncome(fund.address);
            expect(ret.incomeOverQ).to.equal(0);
            expect(ret.incomeOverB).to.equal(0);
        });

        it("Should return zero if the fund loses some value", async function () {
            await advanceBlockAtTime(startWeek - DAY);
            await fund.settle();
            await btc.burn(fund.address, parseBtc("0.3"));
            const ret = await ballot.getFundRelativeIncome(fund.address);
            expect(ret.incomeOverQ).to.equal(0);
            expect(ret.incomeOverB).to.equal(0);
        });

        it("Should return relative income", async function () {
            await advanceBlockAtTime(startWeek - DAY);
            await fund.settle();
            // 30% income (1 QUEEN, 1.3 BTC)
            await btc.mint(fund.address, parseBtc("0.3"));
            const ret1 = await ballot.getFundRelativeIncome(fund.address);
            expect(ret1.incomeOverQ).to.closeTo(parseEther("3").div(13), 10); // 0.3 / 1.3
            expect(ret1.incomeOverB).to.closeTo(parseEther("3").div(5), 10); // 0.3 / 0.5
            // Use 1.3 BTC to create 1 QUEEN
            await pmCreate(addr2, parseBtc("1.3"), parseEther("1"));
            // 2 QUEEN, 2.6 BTC
            const ret2 = await ballot.getFundRelativeIncome(fund.address);
            expect(ret2.incomeOverQ).to.closeTo(parseEther("3").div(13), 10); // 0.6 / 2.6
            expect(ret2.incomeOverB).to.closeTo(parseEther("3").div(5), 10); // 0.6 / 1.0
            // Another 10% income (2 QUEEN, 2.8 BTC)
            await btc.mint(fund.address, parseBtc("0.2"));
            // Redeem 0.5 QUEEN for 0.7 BTC
            await pmRedeem(addr1, parseEther("0.5"), parseBtc("0.7"));
            // 1.5 QUEEN, 2.1 BTC
            const ret3 = await ballot.getFundRelativeIncome(fund.address);
            expect(ret3.incomeOverQ).to.closeTo(parseEther("6").div(21), 10); // 0.6 / 2.1
            expect(ret3.incomeOverB).to.closeTo(parseEther("60").div(75), 10); // 0.6 / 0.75
        });
    });

    describe("count() called by the fund", function () {
        beforeEach(async function () {
            // Ballot result is 60%
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek + WEEK * 10]);
            await ballot.cast(parseEther("0.6"));

            await aprOracle.mock.capture.returns(parseEther("0.2"));
            await setNextBlockTime(startWeek - DAY);
            await fund.settle();
            await twapOracle.mock.getTwap.withArgs(startWeek).returns(parseEther("1250"));
            await setNextBlockTime(startWeek);
            await fund.settle(); // navSum = 2.5, navB = 1.2, navR = 1.3
            // Underlying price is increased by 20%
            await twapOracle.mock.getTwap.withArgs(startWeek + DAY).returns(parseEther("1500"));
            // Underlying amount is increased by 10%
            await btc.mint(fund.address, parseBtc("0.1"));
            // NAV at the next settlement: navSum = 3.3, navB = 1.44, navR = 1.86
        });

        it("Should return the ballot result", async function () {
            await setNextBlockTime(startWeek + DAY);
            await fund.settle();
            // Fund income relative to navSum: 0.3 / 3.3
            // Additional interest rate: 0.3 * 60% / 1.44 = 0.125
            // Final interest rate: 0.2 + 0.125 = 0.325
            expect(await fund.historicalInterestRate(startWeek + DAY)).to.closeTo(
                parseEther("0.325"),
                1e6
            );
        });

        it("Should return zero if the fund is just rebalanced", async function () {
            await twapOracle.mock.getTwap.withArgs(startWeek + DAY).returns(parseEther("2000"));
            await advanceBlockAtTime(startWeek + DAY);
            await fund.settle();
            expect(await fund.historicalInterestRate(startWeek + DAY)).to.equal(parseEther("0.2"));
        });
    });
});
