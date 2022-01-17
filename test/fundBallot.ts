import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import { WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";

describe("FundBallot", function () {
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
    let fund1: string;
    let fund2: string;
    let votingEscrow: MockContract;
    let ballot: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, fund1, fund2, fund3, owner] = provider.getWallets();

        // Start at the settlement time in the next Thursday.
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        await advanceBlockAtTime(startWeek);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.maxTime.returns(200 * WEEK);

        const FundBallot = await ethers.getContractFactory("FundBallot");
        const ballot = await FundBallot.connect(owner).deploy(votingEscrow.address, [
            fund1.address,
            fund2.address,
            fund3.address,
        ]);

        return {
            wallets: { user1, user2, fund1, fund2, fund3, owner },
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
        fund1 = fixtureData.wallets.fund1.address;
        fund2 = fixtureData.wallets.fund2.address;
        startWeek = fixtureData.startWeek;
        votingEscrow = fixtureData.votingEscrow;
        ballot = fixtureData.ballot;
    });

    describe("cast()", function () {
        it("Should cast votes", async function () {
            const amount = parseEther("1");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);

            await expect(ballot.cast([parseEther("1"), parseEther("0"), parseEther("0")]))
                .to.emit(ballot, "Voted")
                .withArgs(
                    user1.address,
                    [],
                    0,
                    [parseEther("1"), parseEther("0"), parseEther("0")],
                    unlockTime
                );

            expect((await ballot.getReceipt(user1.address)).amount).to.equal(amount);
            expect((await ballot.getReceipt(user1.address)).unlockTime).to.equal(unlockTime);
            expect((await ballot.getReceipt(user1.address)).allocations[0]).to.equal(
                parseEther("1")
            );
            expect((await ballot.getReceipt(user1.address)).allocations[1]).to.equal(
                parseEther("0")
            );
            expect((await ballot.getReceipt(user1.address)).allocations[2]).to.equal(
                parseEther("0")
            );

            expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.scheduledFundUnlock(fund1, unlockTime)).to.equal(amount);

            expect(
                await ballot.balanceOfAtTimestamp(user1.address, startWeek + WEEK * 50)
            ).to.equal(parseEther("0.25"));
            expect(await ballot.totalSupplyAtTimestamp(startWeek + WEEK * 50)).to.equal(
                parseEther("0.25")
            );
            expect(await ballot.sumAtTimestamp(fund1, startWeek + WEEK * 50)).to.equal(
                parseEther("0.25")
            );
        });

        it("Should change the votes", async function () {
            let amount = parseEther("1");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await ballot.cast([parseEther("1"), parseEther("0"), parseEther("0")]);

            amount = parseEther("2");
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await expect(ballot.cast([parseEther("0.2"), parseEther("0.3"), parseEther("0.5")]))
                .to.emit(ballot, "Voted")
                .withArgs(
                    user1.address,
                    [parseEther("1"), parseEther("0"), parseEther("0")],
                    unlockTime,
                    [parseEther("0.4"), parseEther("0.6"), parseEther("1")],
                    unlockTime
                );

            expect((await ballot.getReceipt(user1.address)).amount).to.equal(amount);
            expect((await ballot.getReceipt(user1.address)).unlockTime).to.equal(unlockTime);
            expect((await ballot.getReceipt(user1.address)).allocations[0]).to.equal(
                parseEther("0.4")
            );
            expect((await ballot.getReceipt(user1.address)).allocations[1]).to.equal(
                parseEther("0.6")
            );
            expect((await ballot.getReceipt(user1.address)).allocations[2]).to.equal(
                parseEther("1")
            );

            expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.scheduledFundUnlock(fund2, unlockTime)).to.equal(parseEther("0.6"));

            expect(
                await ballot.balanceOfAtTimestamp(user1.address, startWeek + WEEK * 50)
            ).to.equal(parseEther("0.5"));
            expect(await ballot.totalSupplyAtTimestamp(startWeek + WEEK * 50)).to.equal(
                parseEther("0.5")
            );
            expect(await ballot.sumAtTimestamp(fund2, startWeek + WEEK * 50)).to.equal(
                parseEther("0.6").div(4)
            );
        });

        it("Should revert cast votes with invalid option", async function () {
            await expect(
                ballot.cast([parseEther("0"), parseEther("0"), parseEther("0")])
            ).to.be.revertedWith("Invalid weights");
            await expect(
                ballot.cast([parseEther("1"), parseEther("1"), parseEther("1")])
            ).to.be.revertedWith("Invalid weights");
        });
    });

    describe("count()", function () {
        it("Should return the even ratios when no one has voted", async function () {
            expect((await ballot.count(startWeek)).ratios[0]).to.equal(parseEther("1").div(3));
            expect((await ballot.count(startWeek)).ratios[1]).to.equal(parseEther("1").div(3));
            expect((await ballot.count(startWeek)).ratios[2]).to.equal(parseEther("1").div(3));

            expect((await ballot.count(startWeek)).funds[0]).to.equal(fund1);
            expect((await ballot.count(startWeek)).funds[1]).to.equal(fund2);
        });

        it("Should return the ratios", async function () {
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([parseEther("1"), unlockTime]);
            await ballot.cast([parseEther("1"), parseEther("0"), parseEther("0")]);
            await ballot.connect(user2).cast([parseEther("0"), parseEther("1"), parseEther("0")]);

            expect((await ballot.count(startWeek)).ratios[0]).to.equal(parseEther("0.5"));
            expect((await ballot.count(startWeek)).ratios[1]).to.equal(parseEther("0.5"));
            expect((await ballot.count(startWeek)).ratios[2]).to.equal(parseEther("0"));

            expect((await ballot.count(startWeek + WEEK * 99)).ratios[0]).to.equal(
                parseEther("0.5")
            );
            expect((await ballot.count(startWeek + WEEK * 99)).ratios[1]).to.equal(
                parseEther("0.5")
            );
            expect((await ballot.count(startWeek + WEEK * 99)).ratios[2]).to.equal(parseEther("0"));

            expect((await ballot.count(startWeek + WEEK * 100)).ratios[0]).to.equal(
                parseEther("1").div(3)
            );
            expect((await ballot.count(startWeek + WEEK * 100)).ratios[1]).to.equal(
                parseEther("1").div(3)
            );
            expect((await ballot.count(startWeek + WEEK * 100)).ratios[2]).to.equal(
                parseEther("1").div(3)
            );
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

            await ballot.cast([parseEther("1"), parseEther("0"), parseEther("0")]);
            await ballot.connect(user2).cast([parseEther("0"), parseEther("1"), parseEther("0")]);
            await ballot.connect(owner).cast([parseEther("0"), parseEther("0"), parseEther("1")]);

            const week0Total = 40 + 50 * 3 + 60;
            const week9Total = 30 + 40 * 3 + 50;
            const week24Total = 15 + 25 * 3 + 35;

            expect((await ballot.count(startWeek)).ratios[0]).to.equal(
                parseEther("40").div(week0Total)
            );
            expect((await ballot.count(startWeek)).ratios[1]).to.equal(
                parseEther("50").mul(3).div(week0Total)
            );
            expect((await ballot.count(startWeek)).ratios[2]).to.equal(
                parseEther("60").div(week0Total)
            );

            expect((await ballot.count(startWeek + WEEK * 10)).ratios[0]).to.equal(
                parseEther("30").div(week9Total)
            );
            expect((await ballot.count(startWeek + WEEK * 10)).ratios[1]).to.equal(
                parseEther("40").mul(3).div(week9Total)
            );
            expect((await ballot.count(startWeek + WEEK * 10)).ratios[2]).to.equal(
                parseEther("50").div(week9Total)
            );

            expect((await ballot.count(startWeek + WEEK * 25)).ratios[0]).to.equal(
                parseEther("15").div(week24Total)
            );
            expect((await ballot.count(startWeek + WEEK * 25)).ratios[1]).to.equal(
                parseEther("25").mul(3).div(week24Total)
            );
            expect((await ballot.count(startWeek + WEEK * 25)).ratios[2]).to.equal(
                parseEther("35").div(week24Total)
            );

            expect((await ballot.count(startWeek + WEEK * 50)).ratios[0]).to.equal(parseEther("0"));
            expect((await ballot.count(startWeek + WEEK * 50)).ratios[1]).to.equal(parseEther("0"));
            expect((await ballot.count(startWeek + WEEK * 50)).ratios[2]).to.equal(parseEther("1"));
        });
    });
});
