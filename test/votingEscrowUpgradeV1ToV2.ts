import { expect } from "chai";
import { BigNumber, Contract, Wallet, constants } from "ethers";
const { AddressZero } = constants;
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";

const MAX_TIME = WEEK * 100;
const MAX_TIME_ALLOWED = WEEK * 50;

const LOCKED_AMOUNT_1 = parseEther("100");
const LOCKED_AMOUNT_2 = parseEther("10");
const LOCKED_AMOUNT_3 = parseEther("30");
const LOCKED_WEEK_1 = 10;
const LOCKED_WEEK_2 = 20;
const LOCKED_WEEK_3 = 30;

export function calculateBalanceOf(
    lockAmount: BigNumber,
    unlockTime: number,
    currentTimestamp: number
): BigNumber {
    if (unlockTime <= currentTimestamp) return BigNumber.from("0");
    return lockAmount.mul(unlockTime - currentTimestamp).div(MAX_TIME);
}

const START_BALANCE_1 = calculateBalanceOf(LOCKED_AMOUNT_1, WEEK * LOCKED_WEEK_1, 0);
const START_BALANCE_2 = calculateBalanceOf(LOCKED_AMOUNT_2, WEEK * LOCKED_WEEK_2, 0);
const START_BALANCE_3 = calculateBalanceOf(LOCKED_AMOUNT_3, WEEK * LOCKED_WEEK_3, 0);

describe("VotingEscrow upgrade V1 to V2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly chess: Contract;
        readonly proxyAdmin: Contract;
        readonly votingEscrow: Contract;
        readonly votingEscrowV2Impl: Contract;
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
    let chess: Contract;
    let proxyAdmin: Contract;
    let votingEscrow: Contract;
    let votingEscrowV2Impl: Contract;

    async function upgradeToV2(): Promise<void> {
        const initTx = await votingEscrowV2Impl.populateTransaction.initializeV2(
            owner.address,
            "Vote-escrowed CHESS",
            "veCHESS"
        );
        await proxyAdmin.upgradeAndCall(
            votingEscrow.address,
            votingEscrowV2Impl.address,
            initTx.data
        );
        votingEscrow = await ethers.getContractAt("VotingEscrowV2", votingEscrow.address);
    }

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner] = provider.getWallets();

        // Start in the middle of a week
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + SETTLEMENT_TIME + WEEK * 10;
        await advanceBlockAtTime(startWeek - WEEK / 2);

        const MockToken = await ethers.getContractFactory("MockToken");
        const chess = await MockToken.connect(owner).deploy("Chess", "Chess", 18);

        const VotingEscrow = await ethers.getContractFactory("VotingEscrow");
        const votingEscrowImpl = await VotingEscrow.connect(owner).deploy(
            chess.address,
            AddressZero,
            "veChess",
            "veChess",
            MAX_TIME
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const initTx = await votingEscrowImpl.populateTransaction.initialize(MAX_TIME_ALLOWED);
        const votingEscrowProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            votingEscrowImpl.address,
            proxyAdmin.address,
            initTx.data
        );
        const votingEscrow = VotingEscrow.attach(votingEscrowProxy.address);

        const VotingEscrowV2 = await ethers.getContractFactory("VotingEscrowV2");
        const votingEscrowV2Impl = await VotingEscrowV2.connect(owner).deploy(
            chess.address,
            MAX_TIME
        );

        await chess.mint(user1.address, parseEther("1000"));
        await chess.mint(user2.address, parseEther("1000"));
        await chess.mint(user3.address, parseEther("1000"));

        await chess.connect(user1).approve(votingEscrow.address, parseEther("1000"));
        await chess.connect(user2).approve(votingEscrow.address, parseEther("1000"));
        await chess.connect(user3).approve(votingEscrow.address, parseEther("1000"));

        await votingEscrow
            .connect(user1)
            .createLock(
                LOCKED_AMOUNT_1,
                startWeek + WEEK * LOCKED_WEEK_1,
                ethers.constants.AddressZero,
                "0x"
            );
        await votingEscrow
            .connect(user2)
            .createLock(
                LOCKED_AMOUNT_2,
                startWeek + WEEK * LOCKED_WEEK_2,
                ethers.constants.AddressZero,
                "0x"
            );

        return {
            wallets: { user1, user2, user3, owner },
            startWeek,
            chess,
            proxyAdmin,
            votingEscrow: votingEscrow.connect(user1),
            votingEscrowV2Impl,
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
        chess = fixtureData.chess;
        proxyAdmin = fixtureData.proxyAdmin;
        votingEscrow = fixtureData.votingEscrow;
        votingEscrowV2Impl = fixtureData.votingEscrowV2Impl;
    });

    afterEach(async function () {
        expect(await proxyAdmin.getProxyImplementation(votingEscrow.address)).to.equal(
            votingEscrowV2Impl.address,
            "upgradeToV2() is not called in this test case"
        );
    });

    describe("initializeV2()", function () {
        it("Should revert if not called from proxy admin", async function () {
            await proxyAdmin.upgrade(votingEscrow.address, votingEscrowV2Impl.address);
            votingEscrow = await ethers.getContractAt("VotingEscrowV2", votingEscrow.address);
            await expect(
                votingEscrow.initializeV2(owner.address, "Vote-escrowed CHESS", "veCHESS")
            ).to.be.revertedWith("Only proxy admin");
        });
    });

    describe("V1 status", function () {
        beforeEach(async function () {
            await upgradeToV2();
        });

        it("name() and symbol()", async function () {
            expect(await votingEscrow.name()).to.equal("Vote-escrowed CHESS");
            expect(await votingEscrow.symbol()).to.equal("veCHESS");
        });

        it("maxTimeAllowed()", async function () {
            expect(await votingEscrow.maxTimeAllowed()).to.equal(MAX_TIME_ALLOWED);
        });

        it("callback()", async function () {
            expect(await votingEscrow.callback()).to.equal(ethers.constants.AddressZero);
        });

        it("getLockedBalance()", async function () {
            const lock1 = await votingEscrow.getLockedBalance(addr1);
            expect(lock1.amount).to.equal(LOCKED_AMOUNT_1);
            expect(lock1.unlockTime).to.equal(startWeek + WEEK * LOCKED_WEEK_1);
            const lock2 = await votingEscrow.getLockedBalance(addr2);
            expect(lock2.amount).to.equal(LOCKED_AMOUNT_2);
            expect(lock2.unlockTime).to.equal(startWeek + WEEK * LOCKED_WEEK_2);
            const lock3 = await votingEscrow.getLockedBalance(addr3);
            expect(lock3.amount).to.equal(0);
            expect(lock3.unlockTime).to.equal(0);
        });

        it("totalSupplyAtTimestamp()", async function () {
            expect(await votingEscrow.totalSupplyAtTimestamp(startWeek)).to.equal(
                START_BALANCE_1.add(START_BALANCE_2)
            );
        });
    });

    describe("Lock", function () {
        beforeEach(async function () {
            await upgradeToV2();
        });

        it("createLock()", async function () {
            await votingEscrow
                .connect(user3)
                .createLock(LOCKED_AMOUNT_3, startWeek + WEEK * LOCKED_WEEK_3);
            expect(await votingEscrow.balanceOfAtTimestamp(addr3, startWeek)).to.equal(
                START_BALANCE_3
            );
            await advanceBlockAtTime(startWeek);
            expect(await votingEscrow.balanceOf(addr3)).to.equal(START_BALANCE_3);
        });

        it("increaseAmount()", async function () {
            await expect(votingEscrow.increaseAmount(addr3, LOCKED_AMOUNT_3)).to.be.revertedWith(
                "Cannot add to expired lock"
            );
            await votingEscrow.increaseAmount(addr1, LOCKED_AMOUNT_1);
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.equal(
                LOCKED_AMOUNT_1.mul(2)
            );
            expect(await votingEscrow.balanceOfAtTimestamp(addr1, startWeek)).to.equal(
                START_BALANCE_1.mul(2)
            );
        });

        it("increaseUnlockTime()", async function () {
            await expect(
                votingEscrow
                    .connect(user3)
                    .increaseUnlockTime(startWeek + WEEK * (LOCKED_WEEK_3 + 1))
            ).to.be.revertedWith("Lock expired");
            await votingEscrow
                .connect(user2)
                .increaseUnlockTime(startWeek + WEEK * LOCKED_WEEK_2 * 2);
            expect((await votingEscrow.getLockedBalance(addr2)).unlockTime).to.equal(
                startWeek + WEEK * LOCKED_WEEK_2 * 2
            );
            expect(await votingEscrow.balanceOfAtTimestamp(addr2, startWeek)).to.equal(
                START_BALANCE_2.mul(2)
            );
        });

        it("withdraw()", async function () {
            await advanceBlockAtTime(startWeek + WEEK * LOCKED_WEEK_1);
            await expect(votingEscrow.connect(user2).withdraw()).to.be.revertedWith(
                "The lock is not expired"
            );
            await expect(() => votingEscrow.withdraw()).to.changeTokenBalances(
                chess,
                [user1, votingEscrow],
                [LOCKED_AMOUNT_1, LOCKED_AMOUNT_1.mul(-1)]
            );
            await expect(() => votingEscrow.withdraw()).to.changeTokenBalances(
                chess,
                [user1, votingEscrow],
                [0, 0]
            );
        });
    });

    describe("Total supply", function () {
        it("totalLocked()", async function () {
            await upgradeToV2();
            expect(await votingEscrow.totalLocked()).to.equal(LOCKED_AMOUNT_1.add(LOCKED_AMOUNT_2));
        });

        it("nextWeekSupply()", async function () {
            await advanceBlockAtTime(startWeek + DAY * 10);
            await upgradeToV2();
            const balance1 = calculateBalanceOf(
                LOCKED_AMOUNT_1,
                startWeek + WEEK * LOCKED_WEEK_1,
                startWeek + WEEK * 2
            );
            const balance2 = calculateBalanceOf(
                LOCKED_AMOUNT_2,
                startWeek + WEEK * LOCKED_WEEK_2,
                startWeek + WEEK * 2
            );
            expect(await votingEscrow.nextWeekSupply()).to.equal(balance1.add(balance2));
        });

        it("checkpointWeek()", async function () {
            await advanceBlockAtTime(startWeek + DAY * 10);
            await upgradeToV2();
            expect(await votingEscrow.checkpointWeek()).to.equal(startWeek + WEEK);
        });
    });

    describe("Pause", function () {
        beforeEach(async function () {
            await upgradeToV2();
        });

        it("pauser()", async function () {
            expect(await votingEscrow.pauser()).to.equal(owner.address);
        });

        it("pause() and unpause()", async function () {
            // Expect success
            await votingEscrow.connect(owner).pause();
            await votingEscrow.connect(owner).unpause();
        });
    });
});
