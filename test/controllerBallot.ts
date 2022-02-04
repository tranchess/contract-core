import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import {
    DAY,
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";

describe("ControllerBallot", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly votingEscrow: MockContract;
        readonly ballot: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let user1: Wallet;
    let user2: Wallet;
    let user3: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let addr3: string;
    let pool0: string;
    let pool1: string;
    let pool2: string;
    let pool3: string;
    let votingEscrow: MockContract;
    let ballot: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner, pool0, pool1, pool2, pool3] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        await advanceBlockAtTime(startWeek - DAY);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.maxTime.returns(200 * WEEK);

        const ControllerBallot = await ethers.getContractFactory("ControllerBallot");
        const ballot = await ControllerBallot.connect(owner).deploy(votingEscrow.address);
        await ballot.addPool(pool0.address);
        await ballot.addPool(pool1.address);
        await ballot.addPool(pool2.address);

        return {
            wallets: { user1, user2, user3, owner, pool0, pool1, pool2, pool3 },
            startWeek,
            votingEscrow,
            ballot: ballot.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        user3 = fixtureData.wallets.user3;
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        addr2 = user2.address;
        addr3 = user3.address;
        pool0 = fixtureData.wallets.pool0.address;
        pool1 = fixtureData.wallets.pool1.address;
        pool2 = fixtureData.wallets.pool2.address;
        pool3 = fixtureData.wallets.pool3.address;
        startWeek = fixtureData.startWeek;
        votingEscrow = fixtureData.votingEscrow;
        ballot = fixtureData.ballot;
    });

    describe("cast()", function () {
        it("Should reject incorrect length of input array", async function () {
            await expect(ballot.cast([])).to.be.revertedWith("Invalid number of weights");
            await expect(ballot.cast([1, 2, 3, 4])).to.be.revertedWith("Invalid number of weights");
        });

        it("Should reject too large weights", async function () {
            await expect(
                ballot.cast([parseEther("0.3"), parseEther("0.4"), parseEther("0.5")])
            ).to.be.revertedWith("Weights too large");
        });

        it("Should reject vote with no veCHESS", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([0, startWeek + WEEK * 10]);
            await expect(ballot.cast([parseEther("1"), 0, 0])).to.be.revertedWith("No veCHESS");
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek - WEEK]);
            await expect(ballot.cast([parseEther("1"), 0, 0])).to.be.revertedWith("No veCHESS");
        });

        it("Should cast votes", async function () {
            const amount = parseEther("40");
            const unlockTime = startWeek + WEEK * 50;
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unlockTime]);

            await setNextBlockTime(startWeek);
            await ballot.cast([parseEther("0.2"), parseEther("0.3"), parseEther("0.5")]);
            const lockedBalance = await ballot.userLockedBalances(addr1);
            expect(lockedBalance.amount).to.equal(amount);
            expect(lockedBalance.unlockTime).to.equal(unlockTime);
            expect(await ballot.balanceOf(addr1)).to.equal(parseEther("10"));
            expect(await ballot.balanceOfAtTimestamp(addr1, startWeek)).to.equal(parseEther("10"));
            expect(await ballot.userWeights(addr1, pool0)).to.equal(parseEther("0.2"));
            expect(await ballot.userWeights(addr1, pool1)).to.equal(parseEther("0.3"));
            expect(await ballot.userWeights(addr1, pool2)).to.equal(parseEther("0.5"));
        });

        it("Should change the votes", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("40"), startWeek + WEEK * 50]);
            await ballot.cast([parseEther("0.2"), parseEther("0.3"), parseEther("0.5")]);
            const amount = parseEther("80");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unlockTime]);

            await setNextBlockTime(startWeek);
            await ballot.cast([parseEther("0.4"), parseEther("0.2"), parseEther("0.1")]);
            const lockedBalance = await ballot.userLockedBalances(addr1);
            expect(lockedBalance.amount).to.equal(amount);
            expect(lockedBalance.unlockTime).to.equal(unlockTime);
            expect(await ballot.balanceOf(addr1)).to.equal(parseEther("40"));
            expect(await ballot.balanceOfAtTimestamp(addr1, startWeek)).to.equal(parseEther("40"));
            expect(await ballot.userWeights(addr1, pool0)).to.equal(parseEther("0.4"));
            expect(await ballot.userWeights(addr1, pool1)).to.equal(parseEther("0.2"));
            expect(await ballot.userWeights(addr1, pool2)).to.equal(parseEther("0.1"));
        });

        it("Should update pool data", async function () {
            const w50 = startWeek + WEEK * 50;
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("40"), w50]);
            await setNextBlockTime(startWeek);
            await ballot.cast([parseEther("0.2"), parseEther("0.3"), parseEther("0.5")]);
            expect(await ballot.poolScheduledUnlock(pool0, w50)).to.equal(parseEther("8"));
            expect(await ballot.poolScheduledUnlock(pool1, w50)).to.equal(parseEther("12"));
            expect(await ballot.poolScheduledUnlock(pool2, w50)).to.equal(parseEther("20"));
            expect(await ballot.totalSupply()).to.equal(parseEther("10"));
            expect(await ballot.totalSupplyAtTimestamp(startWeek)).to.equal(parseEther("10"));
            expect(await ballot.sumAtTimestamp(pool0, startWeek)).to.equal(parseEther("2"));
            expect(await ballot.sumAtTimestamp(pool1, startWeek)).to.equal(parseEther("3"));
            expect(await ballot.sumAtTimestamp(pool2, startWeek)).to.equal(parseEther("5"));

            const w100 = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr2)
                .returns([parseEther("80"), w100]);
            await ballot
                .connect(user2)
                .cast([parseEther("0.4"), parseEther("0.2"), parseEther("0.1")]);
            expect(await ballot.poolScheduledUnlock(pool0, w100)).to.equal(parseEther("32"));
            expect(await ballot.poolScheduledUnlock(pool1, w100)).to.equal(parseEther("16"));
            expect(await ballot.poolScheduledUnlock(pool2, w100)).to.equal(parseEther("8"));
            expect(await ballot.totalSupplyAtTimestamp(startWeek)).to.equal(parseEther("38"));
            expect(await ballot.sumAtTimestamp(pool0, startWeek)).to.equal(parseEther("18"));
            expect(await ballot.sumAtTimestamp(pool1, startWeek)).to.equal(parseEther("11"));
            expect(await ballot.sumAtTimestamp(pool2, startWeek)).to.equal(parseEther("9"));
        });

        it("Should emit event", async function () {
            const amount1 = parseEther("1");
            const unlockTime1 = startWeek + WEEK * 10;
            const weights1 = [parseEther("1"), 0, 0];
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([amount1, unlockTime1]);
            await expect(ballot.cast(weights1))
                .to.emit(ballot, "Voted")
                .withArgs(addr1, 0, 0, [0, 0, 0], amount1, unlockTime1, weights1);

            const amount2 = parseEther("10");
            const unlockTime2 = startWeek + WEEK * 100;
            const weights2 = [parseEther("0.2"), parseEther("0.3"), parseEther("0.5")];
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([amount2, unlockTime2]);
            await expect(ballot.cast(weights2))
                .to.emit(ballot, "Voted")
                .withArgs(addr1, amount1, unlockTime1, weights1, amount2, unlockTime2, weights2);
        });
    });

    describe("syncWithVotingEscrow()", function () {
        it("Should do nothing if the user did not vote before", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek + WEEK * 10]);
            await ballot.syncWithVotingEscrow(addr1);
            expect(await ballot.balanceOf(addr1)).to.equal(0);
        });

        it("Should do nothing if the user owns no veCHESS", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek + WEEK * 10]);
            await ballot.cast([parseEther("1"), 0, 0]);
            await advanceBlockAtTime(startWeek + WEEK * 10);
            await ballot.syncWithVotingEscrow(addr1);
            expect(await ballot.balanceOf(addr1)).to.equal(0);
        });

        it("Should update votes", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("10"), startWeek + WEEK * 10]);
            await ballot.cast([parseEther("0.2"), parseEther("0.3"), parseEther("0.5")]);
            const amount = parseEther("40");
            const unlockTime = startWeek + WEEK * 50;
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unlockTime]);

            await setNextBlockTime(startWeek);
            await ballot.syncWithVotingEscrow(addr1);
            const lockedBalance = await ballot.userLockedBalances(addr1);
            expect(lockedBalance.amount).to.equal(amount);
            expect(lockedBalance.unlockTime).to.equal(unlockTime);
            expect(await ballot.balanceOf(addr1)).to.equal(parseEther("10"));
            expect(await ballot.balanceOfAtTimestamp(addr1, startWeek)).to.equal(parseEther("10"));
            expect(await ballot.userWeights(addr1, pool0)).to.equal(parseEther("0.2"));
            expect(await ballot.userWeights(addr1, pool1)).to.equal(parseEther("0.3"));
            expect(await ballot.userWeights(addr1, pool2)).to.equal(parseEther("0.5"));
        });
    });

    describe("count()", function () {
        it("Should return the even weights when no one has voted", async function () {
            const weights = (await ballot.count(startWeek)).weights;
            expect(weights[0]).to.equal(parseEther("1").div(3));
            expect(weights[1]).to.equal(parseEther("1").div(3));
            expect(weights[2]).to.equal(parseEther("1").div(3));
        });

        it("Should return the pools", async function () {
            expect((await ballot.count(startWeek)).pools).to.eql([pool0, pool1, pool2]);
        });

        it("Should return the weights with two voters", async function () {
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([parseEther("1"), unlockTime]);
            await ballot.cast([parseEther("1"), 0, 0]);
            await ballot.connect(user2).cast([0, parseEther("1"), 0]);

            const weightsW0 = (await ballot.count(startWeek)).weights;
            expect(weightsW0[0]).to.equal(parseEther("0.5"));
            expect(weightsW0[1]).to.equal(parseEther("0.5"));
            expect(weightsW0[2]).to.equal(0);

            const weightsW99 = (await ballot.count(startWeek + WEEK * 99)).weights;
            expect(weightsW99[0]).to.equal(parseEther("0.5"));
            expect(weightsW99[1]).to.equal(parseEther("0.5"));
            expect(weightsW99[2]).to.equal(0);

            const weightsW100 = (await ballot.count(startWeek + WEEK * 100)).weights;
            expect(weightsW100[0]).to.equal(parseEther("1").div(3));
            expect(weightsW100[1]).to.equal(parseEther("1").div(3));
            expect(weightsW100[2]).to.equal(parseEther("1").div(3));
        });

        it("Should return the weights with three voters", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek + WEEK * 40]);
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr2)
                .returns([parseEther("3"), startWeek + WEEK * 50]);
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr3)
                .returns([parseEther("1"), startWeek + WEEK * 60]);

            await ballot.cast([parseEther("0.6"), parseEther("0.3"), parseEther("0.1")]);
            await ballot.connect(user2).cast([0, parseEther("1"), 0]);
            await ballot.connect(user3).cast([parseEther("0.2"), parseEther("0.4"), 0]);

            const totalW0 = 40 + 3 * 50 + 60 * 0.6;
            const sum0W0 = parseEther((40 * 0.6 + 60 * 0.2).toString()).div(totalW0);
            const sum1W0 = parseEther((40 * 0.3 + 3 * 50 + 60 * 0.4).toString()).div(totalW0);
            const sum2W0 = parseEther((40 * 0.1).toString()).div(totalW0);
            const weightsW0 = (await ballot.count(startWeek)).weights;
            expect(weightsW0[0]).to.equal(sum0W0);
            expect(weightsW0[1]).to.equal(sum1W0);
            expect(weightsW0[2]).to.equal(sum2W0);

            const totalW10 = 30 + 3 * 40 + 50 * 0.6;
            const sum0W10 = parseEther((30 * 0.6 + 50 * 0.2).toString()).div(totalW10);
            const sum1W10 = parseEther((30 * 0.3 + 3 * 40 + 50 * 0.4).toString()).div(totalW10);
            const sum2W10 = parseEther((30 * 0.1).toString()).div(totalW10);
            const weightsW10 = (await ballot.count(startWeek + WEEK * 10)).weights;
            expect(weightsW10[0]).to.equal(sum0W10);
            expect(weightsW10[1]).to.equal(sum1W10);
            expect(weightsW10[2]).to.equal(sum2W10);

            const totalW45 = 3 * 5 + 15 * 0.6;
            const sum0W45 = parseEther((15 * 0.2).toString()).div(totalW45);
            const sum1W45 = parseEther((3 * 5 + 15 * 0.4).toString()).div(totalW45);
            const weightsW45 = (await ballot.count(startWeek + WEEK * 45)).weights;
            expect(weightsW45[0]).to.equal(sum0W45);
            expect(weightsW45[1]).to.equal(sum1W45);
            expect(weightsW45[2]).to.equal(0);

            const totalW50 = 10 * 0.6;
            const sum0W50 = parseEther((10 * 0.2).toString()).div(totalW50);
            const sum1W50 = parseEther((10 * 0.4).toString()).div(totalW50);
            const weightsW50 = (await ballot.count(startWeek + WEEK * 50)).weights;
            expect(weightsW50[0]).to.equal(sum0W50);
            expect(weightsW50[1]).to.equal(sum1W50);
            expect(weightsW50[2]).to.equal(0);
        });
    });

    describe("addPool()", function () {
        it("Should reject data if not called by owner", async function () {
            await expect(ballot.addPool(pool3)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should update pools", async function () {
            expect(await ballot.getPools()).to.eql([pool0, pool1, pool2]);
            await ballot.connect(owner).addPool(pool3);
            expect(await ballot.getPools()).to.eql([pool0, pool1, pool2, pool3]);
        });

        it("Should emit event", async function () {
            await expect(ballot.connect(owner).addPool(pool3))
                .to.emit(ballot, "PoolAdded")
                .withArgs(pool3);
        });

        it("Should cast votes after pool added", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), startWeek + WEEK * 10]);
            await ballot.cast([parseEther("1"), 0, 0]);
            await ballot.connect(owner).addPool(pool3);

            const amount = parseEther("2");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unlockTime]);
            await ballot.cast([
                parseEther("0.1"),
                parseEther("0.2"),
                parseEther("0.3"),
                parseEther("0.4"),
            ]);
            expect((await ballot.userLockedBalances(addr1)).amount).to.equal(amount);
            expect((await ballot.userLockedBalances(addr1)).unlockTime).to.equal(unlockTime);
            expect(await ballot.userWeights(addr1, pool0)).to.equal(parseEther("0.1"));
            expect(await ballot.userWeights(addr1, pool1)).to.equal(parseEther("0.2"));
            expect(await ballot.userWeights(addr1, pool2)).to.equal(parseEther("0.3"));
            expect(await ballot.userWeights(addr1, pool3)).to.equal(parseEther("0.4"));
            expect(await ballot.poolScheduledUnlock(pool3, unlockTime)).to.equal(parseEther("0.8"));
            expect(await ballot.sumAtTimestamp(pool3, startWeek + WEEK * 50)).to.equal(
                parseEther("0.8").div(4)
            );
        });
    });
});
