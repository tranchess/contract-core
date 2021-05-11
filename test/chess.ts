import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;

const DAY = 86400;
const WEEK = DAY * 7;

const CUMULATIVE_SUPPLY_SCHEDULE = [
    BigNumber.from(10).pow(18).mul(100),
    BigNumber.from(10).pow(18).mul(140),
    BigNumber.from(10).pow(18).mul(170),
    BigNumber.from(10).pow(18).mul(190),
    BigNumber.from(10).pow(18).mul(200),
];

const WEEKLY_SUPPLY_SCHEDULE = [
    BigNumber.from(10).pow(18).mul(40),
    BigNumber.from(10).pow(18).mul(30),
    BigNumber.from(10).pow(18).mul(20),
    BigNumber.from(10).pow(18).mul(10),
];

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

describe("Chess", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly chess: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let chess: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        // Start at the midnight in the next Thursday.
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK;

        const Chess = await ethers.getContractFactory("Chess");
        const chess = await Chess.connect(owner).deploy(startWeek);
        await chess.addMinter(owner.address);

        return {
            wallets: { user1, user2, owner },
            startWeek,
            chess: chess.connect(user1),
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
        chess = fixtureData.chess;
    });

    describe("At beginning", function () {
        it("Should setup correctly", async function () {
            expect(await chess.getScheduleLength()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE.length);
            for (let i = 0; i < CUMULATIVE_SUPPLY_SCHEDULE.length; i++) {
                expect(await chess.getCumulativeSupply(i)).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[i]);
            }
        });
    });

    describe("getWeeklySupply()", function () {
        it("Should get weekly supply", async function () {
            for (let i = 0; i < WEEKLY_SUPPLY_SCHEDULE.length; i++) {
                expect((await chess.getWeeklySupply(i)).currentWeekCumulativeSupply).to.equal(
                    CUMULATIVE_SUPPLY_SCHEDULE[i]
                );
                expect((await chess.getWeeklySupply(i)).weeklySupply).to.equal(
                    WEEKLY_SUPPLY_SCHEDULE[i]
                );
            }
        });

        it("Should get weekly supply after the end of schedule", async function () {
            expect(
                (await chess.getWeeklySupply(WEEKLY_SUPPLY_SCHEDULE.length))
                    .currentWeekCumulativeSupply
            ).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[CUMULATIVE_SUPPLY_SCHEDULE.length - 1]);
            expect(
                (await chess.getWeeklySupply(WEEKLY_SUPPLY_SCHEDULE.length)).weeklySupply
            ).to.equal(0);
        });
    });

    describe("availableSupply()", function () {
        it("Should get available supply", async function () {
            expect(await chess.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[0]);

            advanceBlockAtTime(startWeek);
            expect(await chess.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[0]);

            advanceBlockAtTime(startWeek + WEEK / 2);
            expect(await chess.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[1]
                    .sub(CUMULATIVE_SUPPLY_SCHEDULE[0])
                    .div(2)
                    .add(CUMULATIVE_SUPPLY_SCHEDULE[0])
            );

            advanceBlockAtTime(startWeek + WEEK + WEEK / 3);
            expect(await chess.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[2]
                    .sub(CUMULATIVE_SUPPLY_SCHEDULE[1])
                    .div(3)
                    .add(CUMULATIVE_SUPPLY_SCHEDULE[1])
            );

            advanceBlockAtTime(startWeek + WEEK * 2 + WEEK / 4);
            expect(await chess.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[3]
                    .sub(CUMULATIVE_SUPPLY_SCHEDULE[2])
                    .div(4)
                    .add(CUMULATIVE_SUPPLY_SCHEDULE[2])
            );
        });

        it("Should get available supply after the end of schedule", async function () {
            advanceBlockAtTime(startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length);
            expect(await chess.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[CUMULATIVE_SUPPLY_SCHEDULE.length - 1]
            );
        });
    });

    describe("getRate()", function () {
        it("Should get rate before start timestamp", async function () {
            expect(await chess.getRate(startWeek - 1)).to.equal(0);
        });

        it("Should get rate", async function () {
            for (let i = 0; i < WEEKLY_SUPPLY_SCHEDULE.length; i++) {
                expect(await chess.getRate(startWeek + WEEK * i)).to.equal(
                    WEEKLY_SUPPLY_SCHEDULE[i].div(WEEK)
                );
            }
        });

        it("Should get rate after the end of schedule", async function () {
            expect(await chess.getRate(startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length)).to.equal(
                0
            );
        });
    });

    describe("mint()", function () {
        it("Should revert if not minter", async function () {
            await expect(chess.connect(user1).mint(addr1, 1)).to.be.revertedWith("Only minter");
        });

        it("Should revert before start timestamp", async function () {
            await expect(chess.connect(owner).mint(addr1, 1)).to.be.revertedWith(
                "Exceeds allowable mint amount"
            );
        });

        it("Should mint", async function () {
            advanceBlockAtTime(startWeek + WEEK / 2);
            const mintingAmount = CUMULATIVE_SUPPLY_SCHEDULE[1]
                .div(2)
                .sub(CUMULATIVE_SUPPLY_SCHEDULE[0].mul(1).div(2));
            await chess.connect(owner).mint(addr1, mintingAmount);
            expect(await chess.balanceOf(addr1)).to.equal(mintingAmount);
        });
    });
});
