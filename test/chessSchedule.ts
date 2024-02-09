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
    parseEther("42921315"),
    parseEther("43931928"),
    parseEther("44894622"),
    parseEther("45810235"),
    parseEther("46679580"),
    parseEther("47503444"),
    parseEther("48302592"),
    parseEther("49077766"),
    parseEther("49829685"),
    parseEther("50559047"),
    parseEther("51266527"),
    parseEther("51959858"),
    parseEther("52639322"),
    parseEther("53305197"),
    parseEther("53957754"),
    parseEther("54597261"),
    parseEther("55223977"),
    parseEther("55838159"),
    parseEther("56440057"),
    parseEther("57029917"),
    parseEther("57607980"),
    parseEther("58174482"),
    parseEther("58729653"),
    parseEther("59273722"),
    parseEther("59806909"),
    parseEther("60329432"),
    parseEther("60841504"),
    parseEther("61343336"),
    parseEther("61835130"),
    parseEther("62317089"),
    parseEther("62789409"),
    parseEther("63252282"),
    parseEther("63705898"),
    parseEther("64150441"),
    parseEther("64586093"),
    parseEther("65013033"),
    parseEther("65431434"),
    parseEther("65841466"),
    parseEther("66243298"),
    parseEther("66637094"),
    parseEther("67023013"),
    parseEther("67405073"),
    parseEther("67783313"),
    parseEther("68157770"),
    parseEther("68528483"),
    parseEther("68895489"),
    parseEther("69258824"),
    parseEther("69618526"),
    parseEther("69974632"),
    parseEther("70327176"),
    parseEther("70676194"),
    parseEther("71025213"),
    parseEther("71374232"),
    parseEther("71723250"),
    parseEther("72072269"),
    parseEther("72421288"),
    parseEther("72770306"),
    parseEther("73119325"),
    parseEther("73468344"),
    parseEther("73817362"),
    parseEther("74166381"),
    parseEther("74515399"),
    parseEther("74864418"),
    parseEther("75213437"),
    parseEther("75562455"),
    parseEther("75911474"),
    parseEther("76260493"),
    parseEther("76609511"),
    parseEther("76958530"),
    parseEther("77307549"),
    parseEther("77656567"),
    parseEther("77656567"),
    parseEther("78354605"),
    parseEther("78703623"),
    parseEther("79052642"),
    parseEther("79401661"),
    parseEther("79750679"),
    parseEther("80099698"),
    parseEther("80448717"),
    parseEther("80797735"),
    parseEther("81146754"),
    parseEther("81495773"),
    parseEther("81844791"),
    parseEther("82193810"),
    parseEther("82542829"),
    parseEther("82891847"),
    parseEther("83240866"),
    parseEther("83589884"),
    parseEther("83938903"),
    parseEther("84287922"),
    parseEther("84636940"),
    parseEther("84636940"),
    parseEther("85334978"),
    parseEther("85683996"),
    parseEther("86033015"),
    parseEther("86382034"),
    parseEther("86731052"),
    parseEther("87080071"),
    parseEther("87429090"),
    parseEther("87778108"),
    parseEther("88127127"),
    parseEther("88476146"),
    parseEther("88825164"),
    parseEther("89174183"),
    parseEther("89523202"),
    parseEther("89872220"),
    parseEther("90221239"),
    parseEther("90570258"),
    parseEther("90919276"),
    parseEther("91268295"),
    parseEther("91617314"),
    parseEther("91966332"),
    parseEther("92315351"),
    parseEther("92664369"),
    parseEther("93013388"),
    parseEther("93362407"),
    parseEther("93711425"),
    parseEther("94060444"),
    parseEther("94409463"),
    parseEther("94758481"),
    parseEther("95107500"),
    parseEther("95456519"),
    parseEther("95805537"),
    parseEther("96154556"),
    parseEther("96503575"),
    parseEther("96852593"),
    parseEther("97201612"),
    parseEther("97550631"),
    parseEther("97899649"),
    parseEther("98248668"),
    parseEther("98597687"),
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
                expect(await chessSchedule.getWeeklySupply(startWeek + WEEK * i)).to.equal(
                    WEEKLY_SUPPLY_SCHEDULE[i]
                );
            }
        });

        it("Should get zero before the start", async function () {
            expect(await chessSchedule.getWeeklySupply(startWeek - 1)).to.equal(0);
        });

        it("Should get zero after the end of schedule", async function () {
            expect(
                await chessSchedule.getWeeklySupply(
                    startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length
                )
            ).to.equal(0);
        });
    });

    describe("availableSupply()", function () {
        it("Should get available supply", async function () {
            expect(await chessSchedule.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[0]);

            await advanceBlockAtTime(startWeek - 1);
            expect(await chessSchedule.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[0]);

            await advanceBlockAtTime(startWeek + WEEK / 2);
            expect(await chessSchedule.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[1]);

            await advanceBlockAtTime(startWeek + WEEK + WEEK / 3);
            expect(await chessSchedule.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[2]);

            await advanceBlockAtTime(startWeek + WEEK * 2);
            expect(await chessSchedule.availableSupply()).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[3]);
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
