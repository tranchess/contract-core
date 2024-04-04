import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import { WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";

describe("Ballot", function () {
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
    let owner: Wallet;
    let addr1: string;
    let votingEscrow: MockContract;
    let ballot: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        // Start at the settlement time in the next Thursday.
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        await advanceBlockAtTime(startWeek);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.maxTime.returns(200 * WEEK);

        const InterestRateBallot = await ethers.getContractFactory("InterestRateBallot");
        const ballot = await InterestRateBallot.connect(owner).deploy(votingEscrow.address);

        return {
            wallets: { user1, user2, owner },
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
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        startWeek = fixtureData.startWeek;
        votingEscrow = fixtureData.votingEscrow;
        ballot = fixtureData.ballot;
    });

    describe("cast()", function () {
        it("Should cast votes", async function () {
            const amount = parseEther("1");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);

            await expect(ballot.cast(0))
                .to.emit(ballot, "Voted")
                .withArgs(addr1, 0, 0, 0, amount, unlockTime, 0);

            expect((await ballot.getReceipt(addr1)).amount).to.equal(amount);
            expect((await ballot.getReceipt(addr1)).unlockTime).to.equal(unlockTime);
            expect((await ballot.getReceipt(addr1)).weight).to.equal(0);

            expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.scheduledWeightedUnlock(unlockTime)).to.equal(0);

            expect(await ballot.balanceOfAtTimestamp(addr1, startWeek + WEEK * 50)).to.equal(
                parseEther("0.25")
            );
            expect(await ballot.totalSupplyAtTimestamp(startWeek + WEEK * 50)).to.equal(
                parseEther("0.25")
            );
            expect(await ballot.sumAtTimestamp(startWeek + WEEK * 50)).to.equal(0);
        });

        it("Should change the votes", async function () {
            let amount = parseEther("1");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await ballot.cast(0);

            amount = parseEther("2");
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await expect(ballot.cast(1))
                .to.emit(ballot, "Voted")
                .withArgs(
                    addr1,
                    parseEther("1"),
                    unlockTime,
                    0,
                    amount,
                    unlockTime,
                    parseEther("0.02")
                );

            expect((await ballot.getReceipt(addr1)).amount).to.equal(amount);
            expect((await ballot.getReceipt(addr1)).unlockTime).to.equal(unlockTime);
            expect((await ballot.getReceipt(addr1)).weight).to.equal(parseEther("0.02"));

            expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.scheduledWeightedUnlock(unlockTime)).to.equal(
                amount.mul(parseEther("0.02"))
            );

            expect(await ballot.balanceOfAtTimestamp(addr1, startWeek + WEEK * 50)).to.equal(
                parseEther("0.5")
            );
            expect(await ballot.totalSupplyAtTimestamp(startWeek + WEEK * 50)).to.equal(
                parseEther("0.5")
            );
            expect(await ballot.sumAtTimestamp(startWeek + WEEK * 50)).to.equal(
                amount.mul(parseEther("0.02")).div(4)
            );
        });

        it("Should revert cast votes with invalid option", async function () {
            await expect(ballot.cast(3)).to.be.revertedWith("Invalid option");
        });
    });

    describe("count()", function () {
        it("Should return the same simple average", async function () {
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([parseEther("1"), unlockTime]);
            await ballot.cast(0);
            await ballot.connect(user2).cast(1);

            expect(await ballot.count(startWeek)).to.equal(parseEther("0.01"));
            expect(await ballot.count(startWeek + WEEK * 50)).to.equal(parseEther("0.01"));
            expect(await ballot.count(startWeek + WEEK * 99)).to.equal(parseEther("0.01"));
            expect(await ballot.count(startWeek + WEEK * 100)).to.equal(parseEther("0.02"));
        });

        it("Should count with multiple voters", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(user1.address)
                .returns([parseEther("1"), startWeek + WEEK * 40]);
            await votingEscrow.mock.getLockedBalance
                .withArgs(user2.address)
                .returns([parseEther("3"), startWeek + WEEK * 50]);
            await votingEscrow.mock.getLockedBalance
                .withArgs(owner.address)
                .returns([parseEther("1"), startWeek + WEEK * 60]);

            await ballot.cast(0);
            await ballot.connect(user2).cast(1);
            await ballot.connect(owner).cast(2);

            const initialWeightedAverage = parseEther("0")
                .mul(40)
                .add(parseEther("0.02").mul(50).mul(3))
                .add(parseEther("0.04").mul(60))
                .div(40 + 50 * 3 + 60);
            const weightedAverageOn9th = parseEther("0")
                .mul(30)
                .add(parseEther("0.02").mul(40).mul(3))
                .add(parseEther("0.04").mul(50))
                .div(30 + 40 * 3 + 50);
            const weightedAverageOn24th = parseEther("0")
                .mul(15)
                .add(parseEther("0.02").mul(25).mul(3))
                .add(parseEther("0.04").mul(35))
                .div(15 + 25 * 3 + 35);
            const weightedAverageOn49th = parseEther("0.04").mul(10).div(10);

            expect(await ballot.count(startWeek)).to.equal(initialWeightedAverage);
            expect(await ballot.count(startWeek + WEEK * 10)).to.equal(weightedAverageOn9th);
            expect(await ballot.count(startWeek + WEEK * 25)).to.equal(weightedAverageOn24th);
            expect(await ballot.count(startWeek + WEEK * 50)).to.equal(weightedAverageOn49th);
        });
    });
});
