import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;

const DAY = 86400;
const WEEK = DAY * 7;
const SETTLEMENT_TIME = 3600 * 14; // UTC time 14:00 every day

const CUMULATIVE_SUPPLY_SCHEDULE: BigNumber[] = [
    parseEther("180000000"),
    parseEther("180300000"),
    parseEther("180900000"),
    parseEther("181800000"),
    parseEther("183000000"),
    parseEther("185400000"),
    parseEther("187704000"),
    parseEther("189915840"),
    parseEther("192039206"),
    parseEther("194077638"),
    parseEther("196034532"),
    parseEther("197913151"),
    parseEther("199716625"),
    parseEther("201447960"),
    parseEther("203110041"),
    parseEther("204705640"),
    parseEther("206237414"),
    parseEther("207707917"),
    parseEther("209119601"),
    parseEther("210474817"),
    parseEther("211775824"),
    parseEther("213037801"),
    parseEther("214261919"),
    parseEther("215449313"),
    parseEther("216601086"),
    parseEther("217718305"),
    parseEther("218802007"),
    parseEther("219853199"),
    parseEther("220872855"),
    parseEther("221861921"),
    parseEther("222821315"),
    parseEther("223751928"),
    parseEther("224654622"),
    parseEther("225530235"),
    parseEther("226379580"),
    parseEther("227203444"),
    parseEther("228002592"),
    parseEther("228777766"),
    parseEther("229529685"),
    parseEther("230259047"),
    parseEther("230966527"),
    parseEther("231659858"),
    parseEther("232339322"),
    parseEther("233005197"),
    parseEther("233657754"),
    parseEther("234297261"),
    parseEther("234923977"),
    parseEther("235538159"),
    parseEther("236140057"),
    parseEther("236729917"),
    parseEther("237307980"),
    parseEther("237874482"),
    parseEther("238429653"),
    parseEther("238973722"),
    parseEther("239506909"),
    parseEther("240029432"),
    parseEther("240541504"),
    parseEther("241043336"),
    parseEther("241535130"),
    parseEther("242017089"),
    parseEther("242489409"),
    parseEther("242957005"),
    parseEther("243419925"),
    parseEther("243878217"),
    parseEther("244331925"),
    parseEther("244781096"),
    parseEther("245225776"),
    parseEther("245666008"),
    parseEther("246101839"),
    parseEther("246533311"),
    parseEther("246960468"),
    parseEther("247383354"),
    parseEther("247802011"),
    parseEther("248216481"),
    parseEther("248626807"),
    parseEther("249033029"),
    parseEther("249435189"),
    parseEther("249833328"),
    parseEther("250227485"),
    parseEther("250617701"),
    parseEther("251004014"),
    parseEther("251390328"),
    parseEther("251776641"),
    parseEther("252162954"),
    parseEther("252549268"),
    parseEther("252935581"),
    parseEther("253321895"),
    parseEther("253708208"),
    parseEther("254094522"),
    parseEther("254480835"),
    parseEther("254867149"),
    parseEther("255253462"),
    parseEther("255639776"),
    parseEther("256026089"),
    parseEther("256412402"),
    parseEther("256798716"),
    parseEther("257185029"),
    parseEther("257571343"),
    parseEther("257957656"),
    parseEther("258343970"),
    parseEther("258730283"),
    parseEther("259116597"),
    parseEther("259502910"),
    parseEther("259889223"),
    parseEther("260275537"),
    parseEther("260661850"),
    parseEther("261048164"),
    parseEther("261434477"),
    parseEther("261820791"),
    parseEther("262207104"),
    parseEther("262593418"),
    parseEther("262979731"),
    parseEther("263366045"),
    parseEther("263752358"),
    parseEther("264138671"),
    parseEther("264524985"),
    parseEther("264911298"),
    parseEther("265297612"),
    parseEther("265683925"),
    parseEther("266070239"),
    parseEther("266456552"),
    parseEther("266842866"),
    parseEther("267229179"),
    parseEther("267615492"),
    parseEther("268001806"),
    parseEther("268388119"),
    parseEther("268774433"),
    parseEther("269160746"),
    parseEther("269547060"),
    parseEther("269933373"),
    parseEther("270319687"),
    parseEther("270706000"),
    parseEther("271092314"),
    parseEther("271478627"),
    parseEther("271864940"),
    parseEther("272251254"),
    parseEther("272637567"),
    parseEther("273023881"),
    parseEther("273410194"),
    parseEther("273796508"),
    parseEther("274182821"),
    parseEther("274569135"),
    parseEther("274955448"),
    parseEther("275341761"),
    parseEther("275728075"),
    parseEther("276114388"),
    parseEther("276500702"),
    parseEther("276887015"),
    parseEther("277273329"),
    parseEther("277659642"),
    parseEther("278045956"),
    parseEther("278432269"),
    parseEther("278818583"),
    parseEther("279204896"),
    parseEther("279591209"),
    parseEther("279977523"),
    parseEther("280363836"),
    parseEther("280750150"),
    parseEther("281136463"),
    parseEther("281522777"),
    parseEther("281909090"),
    parseEther("282295404"),
    parseEther("282681717"),
    parseEther("283068030"),
    parseEther("283454344"),
    parseEther("283840657"),
    parseEther("284226971"),
    parseEther("284613284"),
    parseEther("284999598"),
    parseEther("285385911"),
    parseEther("285772225"),
    parseEther("286158538"),
    parseEther("286544852"),
    parseEther("286931165"),
    parseEther("287317478"),
    parseEther("287703792"),
    parseEther("288090105"),
    parseEther("288476419"),
    parseEther("288862732"),
    parseEther("289249046"),
    parseEther("289635359"),
    parseEther("290021673"),
    parseEther("290407986"),
    parseEther("290794299"),
    parseEther("291180613"),
    parseEther("291566926"),
    parseEther("291953240"),
    parseEther("292339553"),
    parseEther("292725867"),
    parseEther("293112180"),
    parseEther("293498494"),
    parseEther("293884807"),
    parseEther("294271120"),
    parseEther("294657434"),
    parseEther("295043747"),
    parseEther("295430061"),
    parseEther("295816374"),
    parseEther("296202688"),
    parseEther("296589001"),
    parseEther("296975315"),
    parseEther("297361628"),
    parseEther("297747942"),
    parseEther("298134255"),
    parseEther("298520568"),
    parseEther("298906882"),
    parseEther("299293195"),
    parseEther("299679509"),
    parseEther("300000000"),
];

const WEEKLY_SUPPLY_SCHEDULE: BigNumber[] = [];
for (let i = 0; i < CUMULATIVE_SUPPLY_SCHEDULE.length - 1; i++) {
    WEEKLY_SUPPLY_SCHEDULE.push(
        CUMULATIVE_SUPPLY_SCHEDULE[i + 1].sub(CUMULATIVE_SUPPLY_SCHEDULE[i])
    );
}

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
    let owner: Wallet;
    let addr1: string;
    let chess: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp + WEEK;
        const startWeek =
            Math.floor((startTimestamp + WEEK - SETTLEMENT_TIME) / WEEK) * WEEK + SETTLEMENT_TIME;

        const Chess = await ethers.getContractFactory("Chess");
        const chess = await Chess.connect(owner).deploy(startTimestamp);
        await chess.addMinter(owner.address);

        return {
            wallets: { user1, owner },
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
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        startWeek = fixtureData.startWeek;
        chess = fixtureData.chess;
    });

    describe("At beginning", function () {
        it("Should setup correctly", async function () {
            expect(await chess.startTimestamp()).to.equal(startWeek);
            expect(await chess.balanceOf(owner.address)).to.equal(CUMULATIVE_SUPPLY_SCHEDULE[0]);
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

            advanceBlockAtTime(startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length + DAY * 100);
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

            expect(
                await chess.getRate(startWeek + WEEK * WEEKLY_SUPPLY_SCHEDULE.length + DAY * 100)
            ).to.equal(0);
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
