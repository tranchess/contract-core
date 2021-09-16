import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import {
    TRANCHE_M,
    TRANCHE_A,
    TRANCHE_B,
    DAY,
    HOUR,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
} from "./utils";

const UPPER_REBALANCE_THRESHOLD = parseEther("2");
const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");
const MAX_UINT256 = BigNumber.from(2).pow(256).sub(1);
const SUB_MAX_UINT256 = MAX_UINT256.div(parseEther("1"));

describe("Share", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly twapOracle: MockContract;
        readonly shareM: Contract;
        readonly shareA: Contract;
        readonly shareB: Contract;
        readonly fund: Contract;
    }

    // Initial balances
    // User 1: 400 M + 100 A
    // User 2:         200 A + 300 B
    // Total:  400 M + 300 A + 300 B = 1000 total shares
    const INIT_P_1 = parseEther("400");
    const INIT_A_1 = parseEther("100");
    const INIT_B_1 = parseEther("0");
    const INIT_P_2 = parseEther("0");
    const INIT_A_2 = parseEther("200");
    const INIT_B_2 = parseEther("300");
    const INIT_BTC = parseBtc("1");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let shareM: Contract;
    let shareA: Contract;
    let shareB: Contract;
    let addr1: string;
    let addr2: string;
    let twapOracle: MockContract;
    let fund: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startDay = Math.floor(startTimestamp / DAY) * DAY + DAY * 10 + SETTLEMENT_TIME;
        await advanceBlockAtTime(startDay - DAY / 2);

        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        await twapOracle.mock.getTwap.returns(parseEther("1000"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);

        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(parseEther("0.1"));

        const interestRateBallot = await deployMockForName(owner, "IBallot");
        await interestRateBallot.mock.count.returns(0);

        const primaryMarket = await deployMockForName(owner, "IPrimaryMarket");
        await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

        const Fund = await ethers.getContractFactory("Fund");
        const fund = await Fund.connect(owner).deploy(
            btc.address,
            8,
            0,
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            interestRateBallot.address,
            feeCollector.address
        );

        await primaryMarket.call(btc, "approve", fund.address, BigNumber.from("2").pow(256).sub(1));

        const Share = await ethers.getContractFactory("Share");
        const shareM = await Share.connect(owner).deploy("Token M", "M", fund.address, TRANCHE_M);
        const shareA = await Share.connect(owner).deploy("Token A", "A", fund.address, TRANCHE_A);
        const shareB = await Share.connect(owner).deploy("Token B", "B", fund.address, TRANCHE_B);

        await fund.initialize(
            shareM.address,
            shareA.address,
            shareB.address,
            primaryMarket.address
        );

        await advanceBlockAtTime(startDay);
        await fund.settle();
        const addr1 = user1.address;
        const addr2 = user2.address;
        await primaryMarket.call(fund, "mint", TRANCHE_M, addr1, INIT_P_1);
        await primaryMarket.call(fund, "mint", TRANCHE_A, addr1, INIT_A_1);
        await primaryMarket.call(fund, "mint", TRANCHE_B, addr1, INIT_B_1);
        await primaryMarket.call(fund, "mint", TRANCHE_M, addr2, INIT_P_2);
        await primaryMarket.call(fund, "mint", TRANCHE_A, addr2, INIT_A_2);
        await primaryMarket.call(fund, "mint", TRANCHE_B, addr2, INIT_B_2);
        await btc.mint(fund.address, INIT_BTC);
        await advanceBlockAtTime(startDay + DAY);
        await fund.settle();

        return {
            wallets: { user1, user2 },
            twapOracle,
            shareM: shareM.connect(user1),
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
        shareM = fixtureData.shareM;
        shareA = fixtureData.shareA;
        shareB = fixtureData.shareB;
        addr1 = user1.address;
        addr2 = user2.address;
        twapOracle = fixtureData.twapOracle;
        fund = fixtureData.fund;
    });

    // Trigger a new rebalance at the given NAV of Token M
    async function mockRebalance(navM: BigNumber) {
        const lastPrice = await twapOracle.getTwap(0);
        const newPrice = lastPrice.mul(navM).div(parseEther("1"));
        await twapOracle.mock.getTwap.returns(newPrice);
        await advanceOneDayAndSettle();
        await advanceBlockAtTime((await fund.currentDay()).toNumber() - HOUR);
    }

    // NAV before rebalance: (1.7, 1.1, 2.3)
    // 1 M => 1.7 M'
    // 1 A => 0.1 M' + 1 A'
    // 1 B => 1.3 M'        + 1 B'
    const preDefinedRebalance170 = () => mockRebalance(parseEther("1.7"));

    // NAV before rebalance: (0.7, 1.1, 0.3)
    // 1 M => 0.7 M'
    // 1 A => 0.8 M' + 0.3 A'
    // 1 B =>                   0.3 B'
    const preDefinedRebalance070 = () => mockRebalance(parseEther("0.7"));

    describe("transfer()", function () {
        it("Should transfer after lower rebalance", async function () {
            await preDefinedRebalance070();

            expect(await shareM.balanceOf(addr1)).to.equal(parseEther("360"));
            expect(await shareM.balanceOf(addr2)).to.equal(parseEther("160"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("30"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("60"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("90"));

            await expect(shareM.transfer(addr2, parseEther("1")))
                .to.emit(shareM, "Transfer")
                .withArgs(addr1, addr2, parseEther("1"));

            expect(await shareM.balanceOf(addr1)).to.equal(parseEther("359"));
            expect(await shareM.balanceOf(addr2)).to.equal(parseEther("161"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("30"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("60"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("90"));
        });

        it("Should transfer after upper rebalance", async function () {
            await preDefinedRebalance170();

            expect(await shareM.balanceOf(addr1)).to.equal(parseEther("690"));
            expect(await shareM.balanceOf(addr2)).to.equal(parseEther("410"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("300"));

            await expect(shareM.transfer(addr2, parseEther("1")))
                .to.emit(shareM, "Transfer")
                .withArgs(addr1, addr2, parseEther("1"));

            expect(await shareM.balanceOf(addr1)).to.equal(parseEther("689"));
            expect(await shareM.balanceOf(addr2)).to.equal(parseEther("411"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("300"));
        });
    });

    describe("transferFrom()", function () {
        beforeEach(async function () {
            await shareM.approve(addr2, parseEther("100"));
            await shareA.approve(addr2, parseEther("100"));
            await shareB.approve(addr2, parseEther("100"));
        });

        it("Should rebalance balances and allowances after lower rebalance and transferFrom", async function () {
            await preDefinedRebalance070();
            await expect(shareM.connect(user2).transferFrom(addr1, addr2, parseEther("1")))
                .to.emit(shareM, "Approval")
                .withArgs(addr1, addr2, parseEther("69"));

            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("69"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("30"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("30"));

            expect(await shareM.balanceOf(addr1)).to.equal(parseEther("359"));
            expect(await shareM.balanceOf(addr2)).to.equal(parseEther("161"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("30"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("60"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("90"));
        });

        it("Should rebalance balances and allowances after upper rebalance and transferFrom", async function () {
            await preDefinedRebalance170();
            await expect(shareM.connect(user2).transferFrom(addr1, addr2, parseEther("1")))
                .to.emit(shareM, "Approval")
                .withArgs(addr1, addr2, parseEther("169"));

            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("169"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));

            expect(await shareM.balanceOf(addr1)).to.equal(parseEther("689"));
            expect(await shareM.balanceOf(addr2)).to.equal(parseEther("411"));
            expect(await shareA.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareA.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("300"));
        });
    });

    describe("approve()", function () {
        beforeEach(async function () {
            await expect(shareM.approve(addr2, parseEther("100")))
                .to.emit(shareM, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
            await expect(shareA.approve(addr2, parseEther("100")))
                .to.emit(shareA, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
            await expect(shareB.approve(addr2, parseEther("100")))
                .to.emit(shareB, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
        });

        it("Should rebalance for extremely large allowance", async function () {
            await shareM.approve(addr2, MAX_UINT256);
            await shareA.approve(addr2, MAX_UINT256);
            await shareB.approve(addr2, MAX_UINT256);

            await preDefinedRebalance070();

            expect(await shareM.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareA.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);

            await shareM.approve(addr2, MAX_UINT256);
            await shareA.approve(addr2, MAX_UINT256);
            await shareB.approve(addr2, MAX_UINT256);

            await preDefinedRebalance170();

            expect(await shareM.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareA.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
        });

        it("Should rebalance allowance after lower rebalance", async function () {
            await preDefinedRebalance070();

            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("70"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("30"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("30"));
        });

        it("Should rebalance allowance after upper rebalance", async function () {
            await preDefinedRebalance170();

            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("170"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));
        });
    });

    describe("increaseAllowance()/decreaseAllowance()", function () {
        beforeEach(async function () {
            await shareM.increaseAllowance(addr2, parseEther("200"));
            await shareA.increaseAllowance(addr2, parseEther("200"));
            await shareB.increaseAllowance(addr2, parseEther("200"));

            await shareM.decreaseAllowance(addr2, parseEther("100"));
            await shareA.decreaseAllowance(addr2, parseEther("100"));
            await shareB.decreaseAllowance(addr2, parseEther("100"));
        });

        it("Should rebalance for extremely large allowance", async function () {
            await shareM.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));
            await shareA.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));
            await shareB.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));

            await preDefinedRebalance170();

            expect(await shareM.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareA.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
        });

        it("Should rebalance allowance after lower rebalance then upper rebalance", async function () {
            await preDefinedRebalance070();
            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("70"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("30"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("30"));

            await preDefinedRebalance170();
            await shareM.decreaseAllowance(addr2, parseEther("1"));
            await shareA.decreaseAllowance(addr2, parseEther("1"));
            await shareB.decreaseAllowance(addr2, parseEther("1"));

            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("118"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("29"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("29"));
        });

        it("Should rebalance allowance after upper rebalance then lower rebalance", async function () {
            await preDefinedRebalance170();

            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("170"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));

            await preDefinedRebalance070();
            await shareM.decreaseAllowance(addr2, parseEther("1"));
            await shareA.decreaseAllowance(addr2, parseEther("1"));
            await shareB.decreaseAllowance(addr2, parseEther("1"));

            expect(await shareM.allowance(addr1, addr2)).to.equal(parseEther("118"));
            expect(await shareA.allowance(addr1, addr2)).to.equal(parseEther("29"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("29"));
        });
    });
});
