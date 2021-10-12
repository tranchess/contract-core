import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";

const MAX_SUPPLY = parseEther("120000000");

const CUMULATIVE_SUPPLY_SCHEDULE: BigNumber[] = [
    parseEther("0"),
    parseEther("300000"),
    parseEther("900000"),
    parseEther("1800000"),
    parseEther("3000000"),
    parseEther("5400000"),
    parseEther("7704000"),
    parseEther("9915840"),
    parseEther("12039206"),
    parseEther("14077638"),
    parseEther("16034532"),
    parseEther("17913151"),
    parseEther("19716625"),
    parseEther("21447960"),
    parseEther("23110041"),
    parseEther("24705640"),
    parseEther("26237414"),
    parseEther("27707917"),
    parseEther("29119601"),
    parseEther("30474817"),
    parseEther("31775824"),
    parseEther("33037801"),
    parseEther("34261919"),
    parseEther("35449313"),
    parseEther("36601086"),
    parseEther("37718305"),
    parseEther("38802007"),
    parseEther("39853199"),
    parseEther("40872855"),
    parseEther("41861921"),
    parseEther("42821315"),
];

const WEEKLY_SUPPLY_SCHEDULE: BigNumber[] = [];
for (let i = 0; i < CUMULATIVE_SUPPLY_SCHEDULE.length - 1; i++) {
    WEEKLY_SUPPLY_SCHEDULE.push(
        CUMULATIVE_SUPPLY_SCHEDULE[i + 1].sub(CUMULATIVE_SUPPLY_SCHEDULE[i])
    );
}

describe("Chess", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly chess: Contract;
        readonly chessSchedule: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let user1: Wallet;
    let owner: Wallet;
    let addr1: string;
    let chess: Contract;
    let chessSchedule: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner, proxyOwner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp + WEEK;
        const startWeek =
            Math.floor((startTimestamp + WEEK - SETTLEMENT_TIME) / WEEK) * WEEK + SETTLEMENT_TIME;

        const Chess = await ethers.getContractFactory("Chess");
        const chess = await Chess.connect(owner).deploy(MAX_SUPPLY);

        const ChessSchedule = await ethers.getContractFactory("ChessSchedule");
        const chessScheduleImpl = await ChessSchedule.connect(proxyOwner).deploy(
            chess.address,
            startWeek
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const chessScheduleProxy = await TransparentUpgradeableProxy.connect(proxyOwner).deploy(
            chessScheduleImpl.address,
            proxyOwner.address,
            "0x"
        );
        const chessSchedule = ChessSchedule.attach(chessScheduleProxy.address);

        await chess.approve(chessSchedule.address, MAX_SUPPLY);
        await chessSchedule.connect(owner).initialize();
        await chessSchedule.connect(owner).addMinter(owner.address);

        return {
            wallets: { user1, owner },
            startWeek,
            chess,
            chessSchedule: chessSchedule.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        startWeek = fixtureData.startWeek;
        chess = fixtureData.chess;
        chessSchedule = fixtureData.chessSchedule;
    });

    describe("At beginning", function () {
        it("Should setup correctly", async function () {
            expect(await chessSchedule.startTimestamp()).to.equal(startWeek);
            expect(await chess.balanceOf(chessSchedule.address)).to.equal(MAX_SUPPLY);
            expect(await chessSchedule.getScheduleLength()).to.equal(WEEKLY_SUPPLY_SCHEDULE.length);
        });
    });

    describe("getWeeklySupply()", function () {
        it("Should get weekly supply", async function () {
            this.timeout(30000);
            for (let i = 0; i < WEEKLY_SUPPLY_SCHEDULE.length; i++) {
                const ret = await chessSchedule.getWeeklySupply(i);
                expect(ret.currentWeekCumulativeSupply).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[i]);
                expect(ret.weeklySupply).to.equal(WEEKLY_SUPPLY_SCHEDULE[i]);
            }
        });

        it("Should get weekly supply after the end of schedule", async function () {
            const ret = await chessSchedule.getWeeklySupply(WEEKLY_SUPPLY_SCHEDULE.length);
            expect(ret.currentWeekCumulativeSupply).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[CUMULATIVE_SUPPLY_SCHEDULE.length - 1]
            );
            expect(ret.weeklySupply).to.equal(0);
        });
    });

    describe("availableSupply()", function () {
        it("Should get available supply", async function () {
            expect(await chessSchedule.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[0]);

            await advanceBlockAtTime(startWeek);
            expect(await chessSchedule.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[0]);

            await advanceBlockAtTime(startWeek + WEEK / 2);
            expect(await chessSchedule.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[1]
                    .sub(CUMULATIVE_SUPPLY_SCHEDULE[0])
                    .div(2)
                    .add(CUMULATIVE_SUPPLY_SCHEDULE[0])
            );

            await advanceBlockAtTime(startWeek + WEEK + WEEK / 3);
            expect(await chessSchedule.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[2]
                    .sub(CUMULATIVE_SUPPLY_SCHEDULE[1])
                    .div(3)
                    .add(CUMULATIVE_SUPPLY_SCHEDULE[1])
            );

            await advanceBlockAtTime(startWeek + WEEK * 2 + WEEK / 4);
            expect(await chessSchedule.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[3]
                    .sub(CUMULATIVE_SUPPLY_SCHEDULE[2])
                    .div(4)
                    .add(CUMULATIVE_SUPPLY_SCHEDULE[2])
            );
        });

        it("Should get available supply after the end of schedule", async function () {
            await advanceBlockAtTime(startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length);
            expect(await chessSchedule.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[CUMULATIVE_SUPPLY_SCHEDULE.length - 1]
            );

            await advanceBlockAtTime(startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length + DAY * 100);
            expect(await chessSchedule.availableSupply()).to.equal(
                CUMULATIVE_SUPPLY_SCHEDULE[CUMULATIVE_SUPPLY_SCHEDULE.length - 1]
            );
        });
    });

    describe("getRate()", function () {
        it("Should get rate before start timestamp", async function () {
            expect(await chessSchedule.getRate(startWeek - 1)).to.equal(0);
        });

        it("Should get rate", async function () {
            for (let i = 0; i < WEEKLY_SUPPLY_SCHEDULE.length; i++) {
                expect(await chessSchedule.getRate(startWeek + WEEK * i)).to.equal(
                    WEEKLY_SUPPLY_SCHEDULE[i].div(WEEK)
                );
            }
        });

        it("Should get rate after the end of schedule", async function () {
            expect(
                await chessSchedule.getRate(startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length)
            ).to.equal(0);

            expect(
                await chessSchedule.getRate(
                    startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length + DAY * 100
                )
            ).to.equal(0);
        });
    });

    describe("mint()", function () {
        it("Should revert if not minter", async function () {
            await expect(chessSchedule.connect(user1).mint(addr1, 1)).to.be.revertedWith(
                "Only minter"
            );
        });

        it("Should revert before start timestamp", async function () {
            await expect(chessSchedule.connect(owner).mint(addr1, 1)).to.be.revertedWith(
                "Exceeds allowable mint amount"
            );
        });

        it("Should mint", async function () {
            await advanceBlockAtTime(startWeek + WEEK / 2);
            const mintingAmount = CUMULATIVE_SUPPLY_SCHEDULE[1]
                .div(2)
                .sub(CUMULATIVE_SUPPLY_SCHEDULE[0].mul(1).div(2));
            await chessSchedule.connect(owner).mint(addr1, mintingAmount);
            expect(await chess.balanceOf(addr1)).to.equal(mintingAmount);
        });
    });
});
