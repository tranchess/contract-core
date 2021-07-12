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

const MAX_TIME = WEEK * 200;
const ADMIN_FEE_RATE_BPS = 6000; // 40%

describe("FeeDistributor", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly votingEscrow: MockContract;
        readonly btc: Contract;
        readonly feeDistributor: Contract;
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
    let votingEscrow: MockContract;
    let btc: Contract;
    let feeDistributor: Contract;

    /**
     * Calculates the start timestamp of a UNIX week. Week 0 is the week containing `startWeek`.
     *
     * @param weekIndex Index of the week
     * @returns Start timestamp of the UNIX week (Thursday 00:00 UTC)
     */
    function unixWeek(weekIndex: number): number {
        return Math.floor(startWeek / WEEK + weekIndex) * WEEK;
    }

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.maxTime.returns(MAX_TIME);

        // Deploy the contract at Monday 14:00 UTC, 3 days before `startWeek`.
        // This is also the first checkpoint timestamp.
        await setNextBlockTime(startWeek - DAY * 3);
        const FeeDistributor = await ethers.getContractFactory("FeeDistributor");
        const feeDistributor = await FeeDistributor.connect(owner).deploy(
            btc.address,
            votingEscrow.address,
            owner.address,
            parseEther("0.0001").mul(ADMIN_FEE_RATE_BPS)
        );

        return {
            wallets: { user1, user2, user3, owner },
            startWeek,
            votingEscrow,
            btc,
            feeDistributor: feeDistributor.connect(user1),
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
        startWeek = fixtureData.startWeek;
        votingEscrow = fixtureData.votingEscrow;
        btc = fixtureData.btc;
        feeDistributor = fixtureData.feeDistributor;
    });

    describe("syncWithVotingEscrow()", function () {
        it("Should revert if no locked Chess at the end of this week", async function () {
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([0, 0]);
            await expect(feeDistributor.syncWithVotingEscrow(addr1)).to.be.revertedWith(
                "No veCHESS"
            );

            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), unixWeek(0)]);
            await expect(feeDistributor.syncWithVotingEscrow(addr1)).to.be.revertedWith(
                "No veCHESS"
            );
        });

        it("Should update locked balance", async function () {
            const amount = parseEther("1");
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unixWeek(1)]);
            await feeDistributor.syncWithVotingEscrow(addr1);

            const lockedBalance = await feeDistributor.userLockedBalances(addr1);
            expect(lockedBalance.amount).to.equal(amount);
            expect(lockedBalance.unlockTime).to.equal(unixWeek(1));
            // Check veCHESS at startWeek
            const balance = amount.mul(unixWeek(1) - startWeek).div(MAX_TIME);
            expect(await feeDistributor.balanceOfAtTimestamp(addr1, startWeek)).to.equal(balance);
            expect(await feeDistributor.totalSupplyAtTimestamp(startWeek)).to.equal(balance);
            expect(await feeDistributor.nextWeekLocked()).to.equal(amount);
            expect(await feeDistributor.nextWeekSupply()).to.closeToBn(balance, 30);
        });

        it("Should update locked balance before unlocked", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), unixWeek(5)]);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await advanceBlockAtTime(startWeek + DAY * 10);
            const amount = parseEther("2");
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unixWeek(8)]);
            await feeDistributor.syncWithVotingEscrow(addr1);

            // Check veCHESS at the beginning of the next week
            const nextWeek = startWeek + WEEK * 2;
            const balance = amount.mul(unixWeek(8) - nextWeek).div(MAX_TIME);
            expect(await feeDistributor.balanceOfAtTimestamp(addr1, nextWeek)).to.equal(balance);
            expect(await feeDistributor.totalSupplyAtTimestamp(nextWeek)).to.equal(balance);
            expect(await feeDistributor.nextWeekLocked()).to.equal(amount);
            expect(await feeDistributor.nextWeekSupply()).to.closeToBn(balance, 30);
        });

        it("Should update locked balance after unlocked", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), unixWeek(1)]);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await advanceBlockAtTime(startWeek + WEEK * 10);
            const amount = parseEther("2");
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([amount, unixWeek(30)]);
            await feeDistributor.syncWithVotingEscrow(addr1);

            // Check veCHESS at the beginning of the next week
            const nextWeek = startWeek + WEEK * 11;
            const balance = amount.mul(unixWeek(30) - nextWeek).div(MAX_TIME);
            expect(await feeDistributor.balanceOfAtTimestamp(addr1, nextWeek)).to.equal(balance);
            expect(await feeDistributor.totalSupplyAtTimestamp(nextWeek)).to.equal(balance);
            expect(await feeDistributor.nextWeekLocked()).to.equal(amount);
            expect(await feeDistributor.nextWeekSupply()).to.closeToBn(balance, 30);
        });

        it("Should emit an event", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("1"), unixWeek(1)]);
            await expect(feeDistributor.syncWithVotingEscrow(addr1))
                .to.emit(feeDistributor, "Synchronized")
                .withArgs(addr1, 0, 0, parseEther("1"), unixWeek(1));

            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([parseEther("3"), unixWeek(5)]);
            await expect(feeDistributor.syncWithVotingEscrow(addr1))
                .to.emit(feeDistributor, "Synchronized")
                .withArgs(addr1, parseEther("1"), unixWeek(1), parseEther("3"), unixWeek(5));
        });
    });

    describe("checkpoint()", function () {
        it("Should update checkpointTimestamp", async function () {
            await setNextBlockTime(startWeek + DAY * 3 + 123);
            await feeDistributor.checkpoint();
            expect(await feeDistributor.checkpointTimestamp()).to.equal(startWeek + DAY * 3 + 123);

            await setNextBlockTime(startWeek + DAY * 4 + 789);
            await feeDistributor.checkpoint();
            expect(await feeDistributor.checkpointTimestamp()).to.equal(startWeek + DAY * 4 + 789);
        });

        it("Should update lastRewardBalance", async function () {
            await advanceBlockAtTime(startWeek);
            await btc.mint(feeDistributor.address, parseEther("10"));
            await feeDistributor.checkpoint();
            expect(await feeDistributor.lastRewardBalance()).to.equal(parseEther("10"));

            await advanceBlockAtTime(startWeek + DAY * 3);
            await btc.mint(feeDistributor.address, parseEther("2"));
            await feeDistributor.checkpoint();
            expect(await feeDistributor.lastRewardBalance()).to.equal(parseEther("12"));
        });

        it("Should be called in syncWithVotingEscrow()", async function () {
            await votingEscrow.mock.getLockedBalance.returns([parseEther("1"), unixWeek(10)]);
            await setNextBlockTime(startWeek + DAY * 10);
            await feeDistributor.syncWithVotingEscrow(addr1);
            expect(await feeDistributor.checkpointTimestamp()).to.equal(startWeek + DAY * 10);

            await setNextBlockTime(startWeek + DAY * 11);
            await feeDistributor.syncWithVotingEscrow(addr1);
            expect(await feeDistributor.checkpointTimestamp()).to.equal(startWeek + DAY * 11);
        });

        it("Should be called in userCheckpoint()", async function () {
            await setNextBlockTime(startWeek + DAY * 10);
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.checkpointTimestamp()).to.equal(startWeek + DAY * 10);

            await setNextBlockTime(startWeek + DAY * 11);
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.checkpointTimestamp()).to.equal(startWeek + DAY * 11);
        });

        describe("Reward distribution", function () {
            it("Should add received rewards to the current week", async function () {
                await btc.mint(feeDistributor.address, parseEther("1"));
                await feeDistributor.checkpoint();
                expect(await feeDistributor.rewardsPerWeek(startWeek - WEEK)).to.equal(
                    parseEther("1")
                        .mul(10000 - ADMIN_FEE_RATE_BPS)
                        .div(10000)
                );

                await btc.mint(feeDistributor.address, parseEther("10"));
                await feeDistributor.checkpoint();
                expect(await feeDistributor.rewardsPerWeek(startWeek - WEEK)).to.equal(
                    parseEther("11")
                        .mul(10000 - ADMIN_FEE_RATE_BPS)
                        .div(10000)
                );
            });

            it("Should split rewards in two weeks", async function () {
                await btc.mint(feeDistributor.address, parseEther("5"));
                // 5 days since the last checkpoint. 2 days since a new trading week starts.
                await setNextBlockTime(startWeek + DAY * 2);
                await feeDistributor.checkpoint();
                expect(await feeDistributor.rewardsPerWeek(startWeek - WEEK)).to.equal(
                    parseEther("3")
                        .mul(10000 - ADMIN_FEE_RATE_BPS)
                        .div(10000)
                );
                expect(await feeDistributor.rewardsPerWeek(startWeek)).to.equal(
                    parseEther("2")
                        .mul(10000 - ADMIN_FEE_RATE_BPS)
                        .div(10000)
                );
            });

            it("Should split rewards in four weeks", async function () {
                await btc.mint(feeDistributor.address, parseEther("190"));
                // 19 days since the last checkpoint. 2 days since the current trading week starts.
                await setNextBlockTime(startWeek + WEEK * 2 + DAY * 2);
                await feeDistributor.checkpoint();
                const first = parseEther("30")
                    .mul(10000 - ADMIN_FEE_RATE_BPS)
                    .div(10000);
                const middle = parseEther("70")
                    .mul(10000 - ADMIN_FEE_RATE_BPS)
                    .div(10000);
                const last = parseEther("20")
                    .mul(10000 - ADMIN_FEE_RATE_BPS)
                    .div(10000);
                expect(await feeDistributor.rewardsPerWeek(startWeek - WEEK)).to.equal(first);
                expect(await feeDistributor.rewardsPerWeek(startWeek)).to.equal(middle);
                expect(await feeDistributor.rewardsPerWeek(startWeek + WEEK)).to.equal(middle);
                expect(await feeDistributor.rewardsPerWeek(startWeek + WEEK * 2)).to.equal(last);
            });

            it("Should update admin rewards", async function () {
                await btc.mint(feeDistributor.address, parseEther("1"));
                await feeDistributor.checkpoint();
                expect(await feeDistributor.claimableRewards(owner.address)).to.equal(
                    parseEther("1").mul(ADMIN_FEE_RATE_BPS).div(10000)
                );
                // The same for multiple weeks.
                await advanceBlockAtTime(startWeek + WEEK * 10.5);
                await btc.mint(feeDistributor.address, parseEther("100"));
                await feeDistributor.checkpoint();
                expect(await feeDistributor.claimableRewards(owner.address)).to.equal(
                    parseEther("101").mul(ADMIN_FEE_RATE_BPS).div(10000)
                );
            });
        });

        describe("Incremental supply calculation", function () {
            it("Should works for zero supply", async function () {
                await advanceBlockAtTime(startWeek);
                await feeDistributor.checkpoint();
                expect(await feeDistributor.veSupplyPerWeek(startWeek)).to.equal(0);

                await advanceBlockAtTime(startWeek + WEEK * 10);
                await feeDistributor.checkpoint();
                expect(await feeDistributor.veSupplyPerWeek(startWeek + WEEK * 3)).to.equal(0);
            });

            it("Should calculate supply for one week", async function () {
                const amount1 = parseEther("1");
                const amount2 = parseEther("3");
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr1)
                    .returns([amount1, unixWeek(2)]);
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr2)
                    .returns([amount2, unixWeek(5)]);
                await feeDistributor.syncWithVotingEscrow(addr1);
                await feeDistributor.syncWithVotingEscrow(addr2);
                expect(await feeDistributor.veSupplyPerWeek(startWeek)).to.equal(0);

                const balance1 = amount1.mul(unixWeek(2) - startWeek).div(MAX_TIME);
                const balance2 = amount2.mul(unixWeek(5) - startWeek).div(MAX_TIME);
                const supply = balance1.add(balance2);
                await advanceBlockAtTime(startWeek + DAY);
                await feeDistributor.checkpoint();
                expect(await feeDistributor.veSupplyPerWeek(startWeek)).to.closeToBn(supply, 30);

                // The calculated supply in the past does not change any more
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr1)
                    .returns([amount1, unixWeek(100)]);
                await feeDistributor.syncWithVotingEscrow(addr1);
                expect(await feeDistributor.veSupplyPerWeek(startWeek)).to.closeToBn(supply, 30);
                await advanceBlockAtTime(startWeek + DAY * 10);
                await feeDistributor.checkpoint();
                expect(await feeDistributor.veSupplyPerWeek(startWeek)).to.closeToBn(supply, 30);
            });

            it("Should calculate supply for multiple weeks", async function () {
                const amount1 = parseEther("1");
                const amount2 = parseEther("5");
                const amount3 = parseEther("11");
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr1)
                    .returns([amount1, unixWeek(1)]);
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr2)
                    .returns([amount2, unixWeek(2)]);
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr3)
                    .returns([amount3, unixWeek(8)]);
                await feeDistributor.syncWithVotingEscrow(addr1);
                await feeDistributor.syncWithVotingEscrow(addr2);
                await feeDistributor.syncWithVotingEscrow(addr3);
                await advanceBlockAtTime(startWeek + WEEK * 3 - 100);
                await feeDistributor.checkpoint();

                const w0 = startWeek;
                const balance1w0 = amount1.mul(unixWeek(1) - w0).div(MAX_TIME);
                const balance2w0 = amount2.mul(unixWeek(2) - w0).div(MAX_TIME);
                const balance3w0 = amount3.mul(unixWeek(8) - w0).div(MAX_TIME);
                const supply0 = balance1w0.add(balance2w0).add(balance3w0);
                expect(await feeDistributor.veSupplyPerWeek(w0)).to.closeToBn(supply0, 30);

                const w1 = startWeek + WEEK;
                const balance2w1 = amount2.mul(unixWeek(2) - w1).div(MAX_TIME);
                const balance3w1 = amount3.mul(unixWeek(8) - w1).div(MAX_TIME);
                const supply1 = balance2w1.add(balance3w1);
                expect(await feeDistributor.veSupplyPerWeek(w1)).to.closeToBn(supply1, 30);

                const w2 = startWeek + WEEK * 2;
                const supply2 = amount3.mul(unixWeek(8) - w2).div(MAX_TIME);
                expect(await feeDistributor.veSupplyPerWeek(w2)).to.closeToBn(supply2, 30);
            });
        });
    });

    describe("userCheckpoint()", function () {
        it("Should update userWeekCursors", async function () {
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.userWeekCursors(addr1)).to.equal(startWeek - WEEK);

            await advanceBlockAtTime(startWeek + WEEK * 3);
            await feeDistributor.userCheckpoint(addr2);
            expect(await feeDistributor.userWeekCursors(addr2)).to.equal(startWeek + WEEK * 3);
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.userWeekCursors(addr1)).to.equal(startWeek + WEEK * 3);
        });

        it("Should be called in syncWithVotingEscrow()", async function () {
            await votingEscrow.mock.getLockedBalance.returns([parseEther("20"), unixWeek(40)]);

            await feeDistributor.syncWithVotingEscrow(addr1);
            expect(await feeDistributor.userWeekCursors(addr1)).to.equal(startWeek - WEEK);

            await advanceBlockAtTime(startWeek + WEEK * 8);
            await feeDistributor.syncWithVotingEscrow(addr2);
            expect(await feeDistributor.userWeekCursors(addr2)).to.equal(startWeek + WEEK * 8);
            await feeDistributor.syncWithVotingEscrow(addr1);
            expect(await feeDistributor.userWeekCursors(addr1)).to.equal(startWeek + WEEK * 8);
        });

        it("Should update userLastBalances", async function () {
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.userLastBalances(addr1)).to.equal(0);

            const amount = parseEther("0.1");
            await advanceBlockAtTime(startWeek);
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount, unixWeek(3)]);
            await feeDistributor.syncWithVotingEscrow(addr1);
            expect(await feeDistributor.userLastBalances(addr1)).to.equal(0);

            await advanceBlockAtTime(startWeek + WEEK + 1000);
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.userLastBalances(addr1)).to.equal(
                amount.mul(unixWeek(3) - (startWeek + WEEK)).div(MAX_TIME)
            );
        });

        describe("Reward distribution", function () {
            const amount1 = parseEther("10");
            const amount2 = parseEther("4");
            let unlockTime1: number;
            let unlockTime2: number;
            const receivedBtc = parseEther("1");
            const totalRewards = receivedBtc.mul(10000 - ADMIN_FEE_RATE_BPS).div(10000);

            beforeEach(async function () {
                unlockTime1 = unixWeek(2);
                unlockTime2 = unixWeek(5);
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr1)
                    .returns([amount1, unlockTime1]);
                await votingEscrow.mock.getLockedBalance
                    .withArgs(addr2)
                    .returns([amount2, unlockTime2]);
                // User1 syncs before startWeek and user2 syncs after startWeek.
                await feeDistributor.syncWithVotingEscrow(addr1);
                await advanceBlockAtTime(startWeek + DAY);
                await feeDistributor.syncWithVotingEscrow(addr2);
            });

            it("Should give no rewards before the week ends", async function () {
                await btc.mint(feeDistributor.address, receivedBtc);
                await feeDistributor.userCheckpoint(addr1);
                expect(await feeDistributor.claimableRewards(addr1)).to.equal(0);
                await feeDistributor.userCheckpoint(addr2);
                expect(await feeDistributor.claimableRewards(addr2)).to.equal(0);
            });

            it("Should give no rewards for the week of the initial sync", async function () {
                // User1 gets all the rewards after the week.
                await btc.mint(feeDistributor.address, receivedBtc);
                await feeDistributor.checkpoint();
                await advanceBlockAtTime(startWeek + WEEK);
                await feeDistributor.userCheckpoint(addr1);
                expect(await feeDistributor.claimableRewards(addr1)).to.closeToBn(totalRewards, 30);
                await feeDistributor.userCheckpoint(addr2);
                expect(await feeDistributor.claimableRewards(addr2)).to.equal(0);
            });

            it("Should split rewards to all eligible users", async function () {
                await advanceBlockAtTime(startWeek + WEEK);
                await feeDistributor.checkpoint();
                await btc.mint(feeDistributor.address, receivedBtc);
                await feeDistributor.checkpoint();

                await advanceBlockAtTime(startWeek + WEEK * 2);
                const t = startWeek + WEEK;
                const balance1 = amount1.mul(unlockTime1 - t).div(MAX_TIME);
                const balance2 = amount2.mul(unlockTime2 - t).div(MAX_TIME);
                const supply = balance1.add(balance2);
                const reward1 = totalRewards.mul(balance1).div(supply);
                const reward2 = totalRewards.mul(balance2).div(supply);
                await feeDistributor.userCheckpoint(addr1);
                expect(await feeDistributor.claimableRewards(addr1)).to.closeToBn(reward1, 30);
                await feeDistributor.userCheckpoint(addr2);
                expect(await feeDistributor.claimableRewards(addr2)).to.closeToBn(reward2, 30);
            });

            it("Should give no rewards after unlock", async function () {
                await advanceBlockAtTime(startWeek + WEEK * 2);
                // User1's Chess is already unlocked at the beginning of this week
                await feeDistributor.checkpoint();
                await btc.mint(feeDistributor.address, receivedBtc);
                await feeDistributor.checkpoint();

                await advanceBlockAtTime(startWeek + WEEK * 3);
                await feeDistributor.userCheckpoint(addr1);
                expect(await feeDistributor.claimableRewards(addr1)).to.equal(0);
                await feeDistributor.userCheckpoint(addr2);
                expect(await feeDistributor.claimableRewards(addr2)).to.closeToBn(totalRewards, 30);
            });

            it("Should ditribute rewards over multiple weeks", async function () {
                // There are 15 days between the two checkpoints, spanning over 3 weeks.
                // User1 gets rewards from the 1st and 2nd weeks.
                // User2 gets rewards from the 2nd and 3rd weeks.
                await setNextBlockTime(startWeek + DAY * 4);
                await feeDistributor.checkpoint();
                await btc.mint(feeDistributor.address, receivedBtc);
                await setNextBlockTime(startWeek + WEEK * 2 + DAY * 5);
                await feeDistributor.checkpoint();
                const totalRewards1 = totalRewards.mul(3).div(15);
                const totalRewards2 = totalRewards.mul(7).div(15);
                const totalRewards3 = totalRewards.mul(5).div(15);

                // Rewards in the 2nd week.
                const t = startWeek + WEEK;
                const balance1 = amount1.mul(unlockTime1 - t).div(MAX_TIME);
                const balance2 = amount2.mul(unlockTime2 - t).div(MAX_TIME);
                const supply = balance1.add(balance2);
                const splitReward1 = totalRewards2.mul(balance1).div(supply);
                const splitReward2 = totalRewards2.mul(balance2).div(supply);

                await advanceBlockAtTime(startWeek + WEEK * 3);
                const claimable1 = totalRewards1.add(splitReward1);
                const claimable2 = totalRewards3.add(splitReward2);
                await feeDistributor.userCheckpoint(addr1);
                expect(await feeDistributor.claimableRewards(addr1)).to.closeToBn(claimable1, 30);
                await feeDistributor.userCheckpoint(addr2);
                expect(await feeDistributor.claimableRewards(addr2)).to.closeToBn(claimable2, 30);
            });
        });
    });

    describe("claimRewards()", function () {
        const amount1 = parseEther("3");
        const amountAdmin = parseEther("7");
        const receivedBtc = parseEther("200");
        const adminFee = receivedBtc.mul(ADMIN_FEE_RATE_BPS).div(10000);
        const totalRewards = receivedBtc.sub(adminFee);
        const rewards1 = totalRewards.mul(3).div(10);
        const rewardsAdmin = totalRewards.mul(7).div(10);

        beforeEach(async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([amount1, unixWeek(100)]);
            await votingEscrow.mock.getLockedBalance
                .withArgs(owner.address)
                .returns([amountAdmin, unixWeek(100)]);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(owner.address);
            await advanceBlockAtTime(startWeek);
            await feeDistributor.checkpoint();
            await btc.mint(feeDistributor.address, receivedBtc);
            await feeDistributor.checkpoint();
        });

        it("Should transfer no rewards before the week ends", async function () {
            await advanceBlockAtTime(startWeek + WEEK - 10);
            await feeDistributor.claimRewards(addr1);
            expect(await btc.balanceOf(addr1)).to.equal(0);
        });

        it("Should transfer admin fee immediately after checkpoint", async function () {
            await feeDistributor.claimRewards(owner.address);
            expect(await btc.balanceOf(owner.address)).to.equal(adminFee);
        });

        it("Should transfer all rewards", async function () {
            await advanceBlockAtTime(startWeek + WEEK);
            await feeDistributor.claimRewards(addr1);
            expect(await btc.balanceOf(addr1)).to.closeToBn(rewards1, 30);
            await feeDistributor.claimRewards(owner.address);
            expect(await btc.balanceOf(owner.address)).to.closeToBn(adminFee.add(rewardsAdmin), 30);
        });

        it("Should update lastRewardBalance", async function () {
            await advanceBlockAtTime(startWeek + WEEK);
            await feeDistributor.claimRewards(addr1);
            expect(await feeDistributor.lastRewardBalance()).to.closeToBn(
                receivedBtc.sub(rewards1),
                30
            );
        });
    });

    describe("calibrateSupply()", function () {
        beforeEach(async function () {
            // Lock a very small amount of CHESS, so that obtained veCHESS is rounded down to zero.
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([1, unixWeek(10)]);
        });

        it("Reproduce rounding errors", async function () {
            await feeDistributor.syncWithVotingEscrow(addr1);
            // Both account balance and total supply are rounded down when computed from scratch.
            expect(await feeDistributor.balanceOfAtTimestamp(addr1, startWeek)).to.equal(0);
            expect(await feeDistributor.totalSupplyAtTimestamp(startWeek)).to.equal(0);
            // Incremental updated total supply is rounded up.
            expect(await feeDistributor.nextWeekSupply()).to.equal(1);

            // The rounding error is accumulated.
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(addr1);
            expect(await feeDistributor.nextWeekLocked()).to.equal(1);
            expect(await feeDistributor.nextWeekSupply()).to.equal(4);

            // The rounding error persists over weeks.
            await advanceBlockAtTime(startWeek + WEEK * 5);
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.userLastBalances(addr1)).to.equal(0);
            expect(await feeDistributor.nextWeekLocked()).to.equal(1);
            expect(await feeDistributor.nextWeekSupply()).to.equal(4);

            // The rounding error persists even after all Chess unlocked.
            await advanceBlockAtTime(startWeek + WEEK * 20);
            await feeDistributor.userCheckpoint(addr1);
            expect(await feeDistributor.userLastBalances(addr1)).to.equal(0);
            expect(await feeDistributor.nextWeekLocked()).to.equal(0);
            expect(await feeDistributor.nextWeekSupply()).to.equal(4);
        });

        it("Should fix rounding errors in the same week", async function () {
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(addr1);
            expect(await feeDistributor.nextWeekSupply()).to.equal(3);
            await feeDistributor.calibrateSupply();
            expect(await feeDistributor.nextWeekSupply()).to.equal(0);
        });

        it("Should fix rounding errors after some weeks", async function () {
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await advanceBlockAtTime(startWeek + WEEK * 5);
            await feeDistributor.calibrateSupply();
            expect(await feeDistributor.nextWeekSupply()).to.equal(0);
        });
    });

    describe("Balance and supply getters", function () {
        const amount1 = parseEther("123");
        const amount2 = parseEther("456");
        let unlockTime: number;

        beforeEach(async function () {
            unlockTime = unixWeek(50);
            await votingEscrow.mock.getLockedBalance.withArgs(addr1).returns([amount1, unlockTime]);
            await votingEscrow.mock.getLockedBalance.withArgs(addr2).returns([amount2, unlockTime]);
            await feeDistributor.syncWithVotingEscrow(addr1);
            await feeDistributor.syncWithVotingEscrow(addr2);
            await advanceBlockAtTime(startWeek);
        });

        it("balanceOf()", async function () {
            expect(await feeDistributor.balanceOf(addr1)).to.equal(
                amount1.mul(unlockTime - startWeek).div(MAX_TIME)
            );
        });

        it("balanceOfAtTimestamp()", async function () {
            const t = startWeek + WEEK * 3 + 12345;
            expect(await feeDistributor.balanceOfAtTimestamp(addr1, t)).to.equal(
                amount1.mul(unlockTime - t).div(MAX_TIME)
            );
            await expect(
                feeDistributor.balanceOfAtTimestamp(addr1, startWeek - WEEK)
            ).to.be.revertedWith("Must be current or future time");
        });

        it("totalSupply()", async function () {
            expect(await feeDistributor.totalSupply()).to.equal(
                amount1
                    .add(amount2)
                    .mul(unlockTime - startWeek)
                    .div(MAX_TIME)
            );
        });

        it("totalSupplyAtTimestamp()", async function () {
            const t = startWeek + WEEK * 3 + 12345;
            expect(await feeDistributor.totalSupplyAtTimestamp(t)).to.equal(
                amount1
                    .add(amount2)
                    .mul(unlockTime - t)
                    .div(MAX_TIME)
            );
            await expect(
                feeDistributor.totalSupplyAtTimestamp(startWeek - WEEK)
            ).to.be.revertedWith("Must be current or future time");
        });
    });
});
