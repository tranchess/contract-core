import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider, Stub } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseWbtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";

const TRANCHE_P = 0;
const TRANCHE_A = 1;
const TRANCHE_B = 2;
const DAY = 86400;
const HOUR = 3600;
const SETTLEMENT_TIME = 3600 * 14; // UTC time 14:00 every day
const UPPER_CONVERSION_THRESHOLD = parseEther("1.5");
const LOWER_CONVERSION_THRESHOLD = parseEther("0.5");
const FIXED_CONVERSION_THRESHOLD = parseEther("1.1");
const MAX_UINT256 = BigNumber.from(2).pow(256).sub(1);
const SUB_MAX_UINT256 = MAX_UINT256.div(parseEther("1"));

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

describe("Share", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startDay: number;
        readonly startTimestamp: number;
        readonly twapOracle: MockContract;
        readonly aprOracle: MockContract;
        readonly interestRateBallot: MockContract;
        readonly wbtc: Contract;
        readonly shareP: Contract;
        readonly shareA: Contract;
        readonly shareB: Contract;
        readonly fund: Contract;
    }

    // Initial balances
    // User 1: 400 P + 100 A
    // User 2:         200 A + 300 B
    // Total:  400 P + 300 A + 300 B = 1000 total shares
    const INIT_P_1 = parseEther("400");
    const INIT_A_1 = parseEther("100");
    const INIT_B_1 = parseEther("0");
    const INIT_P_2 = parseEther("0");
    const INIT_A_2 = parseEther("200");
    const INIT_B_2 = parseEther("300");
    const INIT_WBTC = parseWbtc("1");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startDay: number;
    let startTimestamp: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let shareP: Contract;
    let shareA: Contract;
    let shareB: Contract;
    let addr1: string;
    let addr2: string;
    let twapOracle: MockContract;
    let wbtc: Contract;
    let fund: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        // Initiating transactions from a Waffle mock contract doesn't work well in Hardhat
        // and may fail with gas estimating errors. We use EOAs for the shares to make
        // test development easier.
        const [user1, user2, owner, governance] = provider.getWallets();

        // Start at 12 hours after settlement time of the 6th day in a week, which makes sure that
        // the first settlement after the fund's deployment settles the last day in a week and
        // starts a new week by updating interest rate of Share A. Many test cases in this file
        // rely on this fact to change the interest rate.
        //
        // As Fund settles at 14:00 everyday and an Unix timestamp starts a week on Thursday,
        // the test cases starts at 2:00 on Thursday (`startTimestamp`) and the first day settles
        // at 14:00 on Thursday (`startDay`).
        let startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const lastDay = Math.ceil(startTimestamp / DAY / 7) * DAY * 7 + DAY * 6 + SETTLEMENT_TIME;
        const startDay = lastDay + DAY;
        startTimestamp = lastDay + 3600 * 12;
        await advanceBlockAtTime(startTimestamp);

        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        await twapOracle.mock.getTwap.returns(parseEther("1000"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const wbtc = await MockToken.connect(owner).deploy("Wrapped BTC", "WBTC", 8);

        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(parseEther("0.1"));

        const interestRateBallot = await deployMockForName(owner, "IBallot");
        await interestRateBallot.mock.count.returns(0);

        const primaryMarket = await deployMockForName(owner, "IPrimaryMarket");
        await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

        const Fund = await ethers.getContractFactory("Fund");
        const fund = await Fund.connect(owner).deploy(
            0,
            UPPER_CONVERSION_THRESHOLD,
            LOWER_CONVERSION_THRESHOLD,
            FIXED_CONVERSION_THRESHOLD,
            twapOracle.address
        );

        await primaryMarket.call(
            wbtc,
            "approve",
            fund.address,
            BigNumber.from("2").pow(256).sub(1)
        );

        const Share = await ethers.getContractFactory("Share");
        const shareP = await Share.connect(owner).deploy("Share P", "P", fund.address, TRANCHE_P);
        const shareA = await Share.connect(owner).deploy("Share A", "A", fund.address, TRANCHE_A);
        const shareB = await Share.connect(owner).deploy("Share B", "B", fund.address, TRANCHE_B);

        await fund.initialize(
            wbtc.address,
            8,
            shareP.address,
            shareA.address,
            shareB.address,
            aprOracle.address,
            interestRateBallot.address,
            primaryMarket.address,
            governance.address
        );

        await advanceBlockAtTime(startDay);
        await fund.settle();
        const addr1 = user1.address;
        const addr2 = user2.address;
        await primaryMarket.call(fund, "mint", TRANCHE_P, addr1, INIT_P_1);
        await primaryMarket.call(fund, "mint", TRANCHE_A, addr1, INIT_A_1);
        await primaryMarket.call(fund, "mint", TRANCHE_B, addr1, INIT_B_1);
        await primaryMarket.call(fund, "mint", TRANCHE_P, addr2, INIT_P_2);
        await primaryMarket.call(fund, "mint", TRANCHE_A, addr2, INIT_A_2);
        await primaryMarket.call(fund, "mint", TRANCHE_B, addr2, INIT_B_2);
        await wbtc.mint(fund.address, INIT_WBTC);
        await advanceBlockAtTime(startDay + DAY);
        await fund.settle();

        return {
            wallets: { user1, user2, owner },
            startDay,
            startTimestamp,
            twapOracle,
            aprOracle,
            interestRateBallot,
            wbtc,
            shareP: shareP.connect(user1),
            shareA: shareA.connect(user1),
            shareB: shareB.connect(user1),
            fund: fund.connect(user1),
        };
    }

    async function advanceOneDayAndSettle() {
        await advanceBlockAtTime((await fund.currentDay()).toNumber());
        await fund.settle();
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        owner = fixtureData.wallets.owner;
        shareP = fixtureData.shareP;
        shareA = fixtureData.shareA;
        shareB = fixtureData.shareB;
        addr1 = user1.address;
        addr2 = user2.address;
        startDay = fixtureData.startDay;
        startTimestamp = fixtureData.startTimestamp;
        wbtc = fixtureData.wbtc;
        twapOracle = fixtureData.twapOracle;
        fund = fixtureData.fund;
    });

    // Trigger a new conversion at the given NAV of Share P
    async function mockConversion(navP: BigNumber) {
        const lastPrice = await twapOracle.getTwap(0);
        const newPrice = lastPrice.mul(navP).div(parseEther("1"));
        await twapOracle.mock.getTwap.returns(newPrice);
        await advanceOneDayAndSettle();
        advanceBlockAtTime((await fund.currentDay()).toNumber() - HOUR);
    }

    // NAV before conversion: (1.6, 1.1, 2.1)
    // 1 P => 1.6 P'
    // 1 A => 0.1 P' + 1 A'
    // 1 B => 1.1 P'        + 1 B'
    const preDefinedConvert160 = () => mockConversion(parseEther("1.6"));

    // NAV before conversion: (2.0, 1.1, 2.9)
    // 1 P => 2.0 P'
    // 1 A => 0.1 P' + 1 A'
    // 1 B => 1.9 P'        + 1 B'
    const preDefinedConvert200 = () => mockConversion(parseEther("2"));

    // NAV before conversion: (0.7, 1.1, 0.3)
    // 1 P => 0.7 P'
    // 1 A => 0.8 P' + 0.3 A'
    // 1 B =>                   0.3 B'
    const preDefinedConvert070 = () => mockConversion(parseEther("0.7"));

    // NAV before conversion: (0.4, 1.1, -0.3)
    // 1 P => 0.4 P'
    // 1 A => 0.8 P'
    // 1 B => 0
    const preDefinedConvert040 = () => mockConversion(parseEther("0.4"));

    describe("transfer()", function () {
        it("Should transfer after lower conversion", async function () {
            await preDefinedConvert070();

            expect(await shareP.balanceOf(addr1)).to.equal(parseEther("360"));
            expect(await shareP.balanceOf(addr2)).to.equal(parseEther("160"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("30"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("60"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("90"));

            await expect(shareP.transfer(addr2, parseEther("1")))
                .to.emit(shareP, "Transfer")
                .withArgs(addr1, addr2, parseEther("1"));

            expect(await shareP.balanceOf(addr1)).to.equal(parseEther("359"));
            expect(await shareP.balanceOf(addr2)).to.equal(parseEther("161"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("30"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("60"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("90"));
        });

        it("Should transfer after upper conversion", async function () {
            await preDefinedConvert160();

            expect(await shareP.balanceOf(addr1)).to.equal(parseEther("650"));
            expect(await shareP.balanceOf(addr2)).to.equal(parseEther("350"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("300"));

            await expect(shareP.transfer(addr2, parseEther("1")))
                .to.emit(shareP, "Transfer")
                .withArgs(addr1, addr2, parseEther("1"));

            expect(await shareP.balanceOf(addr1)).to.equal(parseEther("649"));
            expect(await shareP.balanceOf(addr2)).to.equal(parseEther("351"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("300"));
        });
    });

    describe("transferFrom()", function () {
        beforeEach(async function () {
            await shareP.approve(addr2, parseEther("100"));
            await shareA.approve(addr2, parseEther("100"));
            await shareB.approve(addr2, parseEther("100"));
        });

        it("Should convert balances and allowances after lower conversion and transferFrom", async function () {
            await preDefinedConvert070();
            await expect(shareP.connect(user2).transferFrom(addr1, addr2, parseEther("1")))
                .to.emit(shareP, "Approval")
                .withArgs(addr1, addr2, parseEther("69"));

            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("69"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("30"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("30"));

            expect(await shareP.balanceOf(addr1)).to.equal(parseEther("359"));
            expect(await shareP.balanceOf(addr2)).to.equal(parseEther("161"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("30"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("60"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("90"));
        });

        it("Should convert balances and allowances after upper conversion and transferFrom", async function () {
            await preDefinedConvert160();
            await expect(shareP.connect(user2).transferFrom(addr1, addr2, parseEther("1")))
                .to.emit(shareP, "Approval")
                .withArgs(addr1, addr2, parseEther("159"));

            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("159"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));

            expect(await shareP.balanceOf(addr1)).to.equal(parseEther("649"));
            expect(await shareP.balanceOf(addr2)).to.equal(parseEther("351"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("300"));
        });
    });

    describe("approve()", function () {
        beforeEach(async function () {
            await expect(shareP.approve(addr2, parseEther("100")))
                .to.emit(shareP, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
            await expect(shareA.approve(addr2, parseEther("100")))
                .to.emit(shareA, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
            await expect(shareB.approve(addr2, parseEther("100")))
                .to.emit(shareB, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
        });

        it("Should convert for extremely large allowance", async function () {
            await shareP.approve(addr2, MAX_UINT256);
            await shareA.approve(addr2, MAX_UINT256);
            await shareB.approve(addr2, MAX_UINT256);

            await preDefinedConvert070();

            expect(await shareP.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareA.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);

            await shareP.approve(addr2, MAX_UINT256);
            await shareA.approve(addr2, MAX_UINT256);
            await shareB.approve(addr2, MAX_UINT256);

            await preDefinedConvert160();

            expect(await shareP.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareA.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
        });

        it("Should convert allowance after lower conversion", async function () {
            await preDefinedConvert070();

            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("70"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("30"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("30"));
        });

        it("Should convert allowance after upper conversion", async function () {
            await preDefinedConvert160();

            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("160"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));
        });
    });

    describe("increaseAllowance()/decreaseAllowance()", function () {
        beforeEach(async function () {
            await shareP.increaseAllowance(addr2, parseEther("200"));
            await shareA.increaseAllowance(addr2, parseEther("200"));
            await shareB.increaseAllowance(addr2, parseEther("200"));

            await shareP.decreaseAllowance(addr2, parseEther("100"));
            await shareA.decreaseAllowance(addr2, parseEther("100"));
            await shareB.decreaseAllowance(addr2, parseEther("100"));
        });

        it("Should convert for extremely large allowance", async function () {
            await shareP.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));
            await shareA.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));
            await shareB.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));

            await preDefinedConvert160();

            expect(await shareP.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareA.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
        });

        it("Should convert allowance after lower conversion then upper conversion", async function () {
            await preDefinedConvert070();
            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("70"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("30"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("30"));

            await preDefinedConvert160();
            await shareP.decreaseAllowance(addr2, parseEther("1"));
            await shareA.decreaseAllowance(addr2, parseEther("1"));
            await shareB.decreaseAllowance(addr2, parseEther("1"));

            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("111"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("29"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("29"));
        });

        it("Should convert allowance after upper conversion then lower conversion", async function () {
            await preDefinedConvert160();

            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("160"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));

            await preDefinedConvert070();
            await shareP.decreaseAllowance(addr2, parseEther("1"));
            await shareA.decreaseAllowance(addr2, parseEther("1"));
            await shareB.decreaseAllowance(addr2, parseEther("1"));

            expect(await shareP.allowance(addr1, addr2)).to.equal(parseEther("111"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("29"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("29"));
        });
    });
});
