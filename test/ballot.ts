import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";

const DAY = 86400;
const WEEK = DAY * 7;
const MAX_TIME = 4 * 365 * DAY;

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

describe("Ballot", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly startTimestamp: number;
        readonly votingEscrow: MockContract;
        readonly fund: MockContract;
        readonly ballot: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let fund: MockContract;
    let votingEscrow: MockContract;
    let ballot: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        // Initiating transactions from a Waffle mock contract doesn't work well in Hardhat
        // and may fail with gas estimating errors. We use EOAs for the shares to make
        // test development easier.
        const [user1, user2, owner] = provider.getWallets();

        // Start at 12 hours after the first settlement in the next week.
        // As Fund settles at 14:00 everyday and an Unix timestamp starts a week on Thursday,
        // the test cases starts at 2:00 on Friday and the day settles at 14:00.
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK;
        await advanceBlockAtTime(startWeek);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");

        const InterestRateBallot = await ethers.getContractFactory("InterestRateBallot");
        const ballot = await InterestRateBallot.connect(owner).deploy(votingEscrow.address);

        return {
            wallets: { user1, user2, owner },
            startWeek,
            startTimestamp,
            votingEscrow,
            fund,
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
        fund = fixtureData.fund;
        votingEscrow = fixtureData.votingEscrow;
        ballot = fixtureData.ballot;
    });

    function roundWeek(timestamp: number): number {
        return Math.ceil(timestamp / WEEK) * WEEK;
    }

    describe("cast()", function () {
        it("Should cast votes", async function () {
            const amount = parseEther("1");
            const unlockTime = roundWeek(startWeek + MAX_TIME);
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await ballot.cast(0);

            expect((await ballot.getReceipt(addr1)).amount).to.equal(amount);
            expect((await ballot.getReceipt(addr1)).unlockTime).to.equal(unlockTime);
            expect((await ballot.getReceipt(addr1)).weight).to.equal(0);

            expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.scheduledWeightedUnlock(unlockTime)).to.equal(0);

            expect(await ballot.balanceOfAtTimestamp(addr1, unlockTime - MAX_TIME / 2)).to.equal(
                parseEther("0.5")
            );
            expect(await ballot.totalSupplyAtTimestamp(unlockTime - MAX_TIME / 2)).to.equal(
                parseEther("0.5")
            );
            expect(await ballot.sumAtTimestamp(unlockTime - MAX_TIME / 2)).to.equal(0);
        });

        it("Should change the votes", async function () {
            let amount = parseEther("1");
            const unlockTime = roundWeek(startWeek + MAX_TIME);
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await ballot.cast(0);

            amount = parseEther("2");
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await ballot.cast(1);

            expect((await ballot.getReceipt(addr1)).amount).to.equal(amount);
            expect((await ballot.getReceipt(addr1)).unlockTime).to.equal(unlockTime);
            expect((await ballot.getReceipt(addr1)).weight).to.equal(parseEther("0.02"));

            expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.scheduledWeightedUnlock(unlockTime)).to.equal(
                amount.mul(parseEther("0.02"))
            );

            expect(await ballot.balanceOfAtTimestamp(addr1, unlockTime - MAX_TIME / 2)).to.equal(
                parseEther("1")
            );
            expect(await ballot.totalSupplyAtTimestamp(unlockTime - MAX_TIME / 2)).to.equal(
                parseEther("1")
            );
            expect(await ballot.sumAtTimestamp(unlockTime - MAX_TIME / 2)).to.equal(
                amount.mul(parseEther("0.02")).div(2)
            );
        });

        it("Should revert cast votes with invalid option", async function () {
            await expect(ballot.cast(3)).to.be.revertedWith("invalid option");
        });
    });

    describe("count()", function () {
        it("Should return the same simple average", async function () {
            const unlockTime = roundWeek(startWeek + MAX_TIME);
            await votingEscrow.mock.getLockedBalance.returns([parseEther("1"), unlockTime]);
            await ballot.cast(0);
            await ballot.connect(user2).cast(1);
            await ballot.connect(owner).cast(2);

            expect(await ballot.count(startWeek)).to.equal(0);
            expect(await ballot.count(startWeek + MAX_TIME / 2)).to.equal(parseEther("0.02"));
            expect(await ballot.count(startWeek + MAX_TIME - WEEK)).to.equal(parseEther("0.02"));
            expect(await ballot.count(startWeek + MAX_TIME + WEEK)).to.equal(0);
        });

        it("Should count with multiple voters", async function () {
            await votingEscrow.mock.getLockedBalance.returns([
                parseEther("1"),
                roundWeek(startWeek + MAX_TIME),
            ]);
            await ballot.cast(0);
            await votingEscrow.mock.getLockedBalance.returns([
                parseEther("1"),
                roundWeek(startWeek + MAX_TIME / 2),
            ]);
            await ballot.connect(user2).cast(1);
            await votingEscrow.mock.getLockedBalance.returns([
                parseEther("1"),
                roundWeek(startWeek + MAX_TIME / 4),
            ]);
            await ballot.connect(owner).cast(2);

            expect(await ballot.count(startWeek)).to.equal(BigNumber.from("26708860759493670"));
            expect(await ballot.count(startWeek + MAX_TIME / 4)).to.equal(
                BigNumber.from("5183175033921302")
            );
            expect(await ballot.count(startWeek + MAX_TIME / 2)).to.equal(
                BigNumber.from("135501355013550")
            );
            expect(await ballot.count(startWeek + MAX_TIME / 2 + WEEK)).to.equal(0);
            expect(await ballot.count(startWeek + MAX_TIME + WEEK)).to.equal(0);
        });
    });
});
