import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import { WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";

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
    let owner: Wallet;
    let pool1: string;
    let pool2: string;
    let pool3: string;
    let pool4: string;
    let votingEscrow: MockContract;
    let ballot: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, pool1, pool2, pool3, pool4] = provider.getWallets();

        // Start at the settlement time in the next Thursday.
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        await advanceBlockAtTime(startWeek);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.maxTime.returns(200 * WEEK);

        const ControllerBallot = await ethers.getContractFactory("ControllerBallot");
        const ballot = await ControllerBallot.connect(owner).deploy(votingEscrow.address);
        await ballot.addPool(pool1.address);
        await ballot.addPool(pool2.address);
        await ballot.addPool(pool3.address);

        return {
            wallets: { user1, user2, owner, pool1, pool2, pool3, pool4 },
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
        pool1 = fixtureData.wallets.pool1.address;
        pool2 = fixtureData.wallets.pool2.address;
        pool3 = fixtureData.wallets.pool3.address;
        pool4 = fixtureData.wallets.pool4.address;
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
                .withArgs(user1.address, 0, 0, [], amount, unlockTime, [
                    parseEther("1"),
                    parseEther("0"),
                    parseEther("0"),
                ]);

            expect((await ballot.userLockedBalances(user1.address)).amount).to.equal(amount);
            expect((await ballot.userLockedBalances(user1.address)).unlockTime).to.equal(
                unlockTime
            );
            expect(await ballot.userWeights(user1.address, pool1)).to.equal(parseEther("1"));
            expect(await ballot.userWeights(user1.address, pool2)).to.equal(parseEther("0"));
            expect(await ballot.userWeights(user1.address, pool3)).to.equal(parseEther("0"));

            // expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.poolScheduledUnlock(pool1, unlockTime)).to.equal(amount);

            expect(
                await ballot.balanceOfAtTimestamp(user1.address, startWeek + WEEK * 50)
            ).to.equal(parseEther("0.25"));
            expect(await ballot.totalSupplyAtTimestamp(startWeek + WEEK * 50)).to.equal(
                parseEther("0.25")
            );
            expect(await ballot.sumAtTimestamp(pool1, startWeek + WEEK * 50)).to.equal(
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
                    parseEther("1"),
                    unlockTime,
                    [parseEther("1"), parseEther("0"), parseEther("0")],
                    amount,
                    unlockTime,
                    [parseEther("0.2"), parseEther("0.3"), parseEther("0.5")]
                );

            expect((await ballot.userLockedBalances(user1.address)).amount).to.equal(amount);
            expect((await ballot.userLockedBalances(user1.address)).unlockTime).to.equal(
                unlockTime
            );
            expect(await ballot.userWeights(user1.address, pool1)).to.equal(parseEther("0.2"));
            expect(await ballot.userWeights(user1.address, pool2)).to.equal(parseEther("0.3"));
            expect(await ballot.userWeights(user1.address, pool3)).to.equal(parseEther("0.5"));

            // expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.poolScheduledUnlock(pool2, unlockTime)).to.equal(parseEther("0.6"));

            expect(
                await ballot.balanceOfAtTimestamp(user1.address, startWeek + WEEK * 50)
            ).to.equal(parseEther("0.5"));
            expect(await ballot.totalSupplyAtTimestamp(startWeek + WEEK * 50)).to.equal(
                parseEther("0.5")
            );
            expect(await ballot.sumAtTimestamp(pool2, startWeek + WEEK * 50)).to.equal(
                parseEther("0.6").div(4)
            );
        });

        it("Should revert cast votes with invalid option", async function () {
            await expect(
                ballot.cast([parseEther("1"), parseEther("1"), parseEther("1")])
            ).to.be.revertedWith("Weights too large");
        });
    });

    describe("count()", function () {
        it("Should return the even weights when no one has voted", async function () {
            expect((await ballot.count(startWeek)).weights[0]).to.equal(parseEther("1").div(3));
            expect((await ballot.count(startWeek)).weights[1]).to.equal(parseEther("1").div(3));
            expect((await ballot.count(startWeek)).weights[2]).to.equal(parseEther("1").div(3));

            expect((await ballot.count(startWeek)).pools[0]).to.equal(pool1);
            expect((await ballot.count(startWeek)).pools[1]).to.equal(pool2);
        });

        it("Should return the weights", async function () {
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([parseEther("1"), unlockTime]);
            await ballot.cast([parseEther("1"), parseEther("0"), parseEther("0")]);
            await ballot.connect(user2).cast([parseEther("0"), parseEther("1"), parseEther("0")]);

            expect((await ballot.count(startWeek)).weights[0]).to.equal(parseEther("0.5"));
            expect((await ballot.count(startWeek)).weights[1]).to.equal(parseEther("0.5"));
            expect((await ballot.count(startWeek)).weights[2]).to.equal(parseEther("0"));

            expect((await ballot.count(startWeek + WEEK * 99)).weights[0]).to.equal(
                parseEther("0.5")
            );
            expect((await ballot.count(startWeek + WEEK * 99)).weights[1]).to.equal(
                parseEther("0.5")
            );
            expect((await ballot.count(startWeek + WEEK * 99)).weights[2]).to.equal(
                parseEther("0")
            );

            expect((await ballot.count(startWeek + WEEK * 100)).weights[0]).to.equal(
                parseEther("1").div(3)
            );
            expect((await ballot.count(startWeek + WEEK * 100)).weights[1]).to.equal(
                parseEther("1").div(3)
            );
            expect((await ballot.count(startWeek + WEEK * 100)).weights[2]).to.equal(
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

            expect((await ballot.count(startWeek)).weights[0]).to.equal(
                parseEther("40").div(week0Total)
            );
            expect((await ballot.count(startWeek)).weights[1]).to.equal(
                parseEther("50").mul(3).div(week0Total)
            );
            expect((await ballot.count(startWeek)).weights[2]).to.equal(
                parseEther("60").div(week0Total)
            );

            expect((await ballot.count(startWeek + WEEK * 10)).weights[0]).to.equal(
                parseEther("30").div(week9Total)
            );
            expect((await ballot.count(startWeek + WEEK * 10)).weights[1]).to.equal(
                parseEther("40").mul(3).div(week9Total)
            );
            expect((await ballot.count(startWeek + WEEK * 10)).weights[2]).to.equal(
                parseEther("50").div(week9Total)
            );

            expect((await ballot.count(startWeek + WEEK * 25)).weights[0]).to.equal(
                parseEther("15").div(week24Total)
            );
            expect((await ballot.count(startWeek + WEEK * 25)).weights[1]).to.equal(
                parseEther("25").mul(3).div(week24Total)
            );
            expect((await ballot.count(startWeek + WEEK * 25)).weights[2]).to.equal(
                parseEther("35").div(week24Total)
            );

            expect((await ballot.count(startWeek + WEEK * 50)).weights[0]).to.equal(
                parseEther("0")
            );
            expect((await ballot.count(startWeek + WEEK * 50)).weights[1]).to.equal(
                parseEther("0")
            );
            expect((await ballot.count(startWeek + WEEK * 50)).weights[2]).to.equal(
                parseEther("1")
            );
        });
    });

    describe("addPool()", function () {
        it("Should cast votes after add pool", async function () {
            let amount = parseEther("1");
            const unlockTime = startWeek + WEEK * 100;
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await ballot.cast([parseEther("1"), parseEther("0"), parseEther("0")]);

            await ballot.connect(owner).addPool(pool4);

            await expect(
                ballot.cast([parseEther("1"), parseEther("0"), parseEther("0")])
            ).to.be.revertedWith("Invalid number of weights");

            amount = parseEther("2");
            await votingEscrow.mock.getLockedBalance.returns([amount, unlockTime]);
            await expect(
                ballot.cast([
                    parseEther("0.1"),
                    parseEther("0.2"),
                    parseEther("0.3"),
                    parseEther("0.4"),
                ])
            )
                .to.emit(ballot, "Voted")
                .withArgs(
                    user1.address,
                    parseEther("1"),
                    unlockTime,
                    [parseEther("1"), parseEther("0"), parseEther("0"), parseEther("0")],
                    amount,
                    unlockTime,
                    [parseEther("0.1"), parseEther("0.2"), parseEther("0.3"), parseEther("0.4")]
                );

            expect((await ballot.userLockedBalances(user1.address)).amount).to.equal(amount);
            expect((await ballot.userLockedBalances(user1.address)).unlockTime).to.equal(
                unlockTime
            );
            expect(await ballot.userWeights(user1.address, pool1)).to.equal(parseEther("0.1"));
            expect(await ballot.userWeights(user1.address, pool2)).to.equal(parseEther("0.2"));
            expect(await ballot.userWeights(user1.address, pool3)).to.equal(parseEther("0.3"));
            expect(await ballot.userWeights(user1.address, pool4)).to.equal(parseEther("0.4"));

            // expect(await ballot.scheduledUnlock(unlockTime)).to.equal(amount);
            expect(await ballot.poolScheduledUnlock(pool4, unlockTime)).to.equal(parseEther("0.8"));
            expect(await ballot.sumAtTimestamp(pool4, startWeek + WEEK * 50)).to.equal(
                parseEther("0.8").div(4)
            );
        });
    });
});
