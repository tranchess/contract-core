import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;

const DAY = 86400;
const WEEK = DAY * 7;

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

describe("VestingEscrow", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly endWeek: number;
        readonly initialVestedSupply: BigNumber;
        readonly chess: Contract;
        readonly vestingEscrow: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let initialVestedSupply: BigNumber;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let chess: Contract;
    let vestingEscrow: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const initialVestedSupply = parseEther("100");

        // Start at the midnight in the next Thursday.
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp + WEEK;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + 2 * WEEK;
        const endWeek = Math.ceil(startTimestamp / WEEK) * WEEK + 4 * WEEK;

        const Chess = await ethers.getContractFactory("Chess");
        const chess = await Chess.connect(owner).deploy(startTimestamp);

        const VestingEscrow = await ethers.getContractFactory("VestingEscrow");
        const vestingEscrow = await VestingEscrow.connect(owner).deploy(
            chess.address,
            user1.address,
            startWeek,
            endWeek,
            true
        );

        await chess.connect(owner).approve(vestingEscrow.address, initialVestedSupply);

        await vestingEscrow.connect(owner).initialize(initialVestedSupply);

        return {
            wallets: { user1, user2, owner },
            startWeek,
            endWeek,
            initialVestedSupply,
            chess,
            vestingEscrow: vestingEscrow.connect(owner),
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
        addr2 = user2.address;
        startWeek = fixtureData.startWeek;
        initialVestedSupply = fixtureData.initialVestedSupply;
        chess = fixtureData.chess;
        vestingEscrow = fixtureData.vestingEscrow;
    });

    describe("initialize()", function () {
        it("Should revert with zero amount", async function () {
            await expect(vestingEscrow.initialize(0)).to.revertedWith("Zero amount");
        });

        it("Should revert with already initialized", async function () {
            await expect(vestingEscrow.initialize(initialVestedSupply)).to.revertedWith(
                "Already initialized"
            );
        });
    });

    describe("toggleDisable()", function () {
        it("Should disable the recipient", async function () {
            await expect(vestingEscrow.toggleDisable())
                .to.emit(vestingEscrow, "ToggleDisable")
                .withArgs(true);

            await expect(vestingEscrow.toggleDisable())
                .to.emit(vestingEscrow, "ToggleDisable")
                .withArgs(false);
        });
    });

    describe("disableCanDisable()", function () {
        it("Should disable canDisable", async function () {
            await vestingEscrow.disableCanDisable();

            await expect(vestingEscrow.toggleDisable()).to.be.revertedWith("Cannot disable");
        });
    });

    describe("claim()", function () {
        it("Should have nothing to claim before startTime", async function () {
            expect(await vestingEscrow.vestedSupply()).to.equal(0);
            expect(await vestingEscrow.lockedSupply()).to.equal(initialVestedSupply);
            expect(await vestingEscrow.balanceOf(addr1)).to.equal(0);

            await expect(vestingEscrow.claim()).to.emit(vestingEscrow, "Claim").withArgs(0);
        });

        it("Should have a clean state at the beginning of start time", async function () {
            advanceBlockAtTime(startWeek);
            expect(await vestingEscrow.vestedSupply()).to.equal(0);
            expect(await vestingEscrow.lockedSupply()).to.equal(initialVestedSupply);
            expect(await vestingEscrow.balanceOf(addr1)).to.equal(0);
        });

        it("Should claim", async function () {
            const halfVestedSupply = initialVestedSupply.div(2);
            advanceBlockAtTime(startWeek + WEEK);

            expect(await vestingEscrow.totalClaimed()).to.equal(0);
            expect(await vestingEscrow.vestedSupply()).to.equal(halfVestedSupply);
            expect(await vestingEscrow.lockedSupply()).to.equal(halfVestedSupply);
            expect(await vestingEscrow.balanceOf(addr1)).to.equal(halfVestedSupply);

            await vestingEscrow.claim();

            const claimed = await chess.balanceOf(addr1);
            expect(await vestingEscrow.totalClaimed()).to.equal(claimed);
            expect(await vestingEscrow.vestedSupply()).to.equal(claimed);
            expect(await vestingEscrow.lockedSupply()).to.equal(initialVestedSupply.sub(claimed));
            expect(await vestingEscrow.balanceOf(addr1)).to.equal(0);
        });

        it("Should have nothing to claim at the end", async function () {
            advanceBlockAtTime(startWeek + WEEK * 2);

            expect(await vestingEscrow.totalClaimed()).to.equal(0);
            expect(await vestingEscrow.vestedSupply()).to.equal(initialVestedSupply);
            expect(await vestingEscrow.lockedSupply()).to.equal(0);
            expect(await vestingEscrow.balanceOf(addr1)).to.equal(initialVestedSupply);
            expect(await vestingEscrow.balanceOf(addr2)).to.equal(0);

            await vestingEscrow.claim();

            expect(await chess.balanceOf(addr1)).to.equal(initialVestedSupply);
            expect(await vestingEscrow.totalClaimed()).to.equal(initialVestedSupply);
            expect(await vestingEscrow.vestedSupply()).to.equal(initialVestedSupply);
            expect(await vestingEscrow.lockedSupply()).to.equal(0);
            expect(await vestingEscrow.balanceOf(addr1)).to.equal(0);
        });
    });
});
