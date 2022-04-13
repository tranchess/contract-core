import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import {
    TRANCHE_Q,
    TRANCHE_B,
    TRANCHE_R,
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

describe("ShareV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly twapOracle: MockContract;
        readonly shareQ: Contract;
        readonly shareB: Contract;
        readonly shareR: Contract;
        readonly fund: Contract;
    }

    const SPLIT_RATIO = parseEther("500");
    // Initial balances
    // User 1: 0.4 Q + 100 B
    // User 2:         200 B + 300 R
    // Total:  0.4 Q + 300 B + 300 R = 1 equivalent Q
    const INIT_Q_1 = parseEther("0.4");
    const INIT_B_1 = parseEther("100");
    const INIT_R_1 = parseEther("0");
    const INIT_Q_2 = parseEther("0");
    const INIT_B_2 = parseEther("200");
    const INIT_R_2 = parseEther("300");
    const INIT_BTC = parseBtc("1");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let shareQ: Contract;
    let shareB: Contract;
    let shareR: Contract;
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

        const primaryMarket = await deployMockForName(owner, "IPrimaryMarketV3");
        await primaryMarket.mock.settle.returns();

        // Predict address of the shares
        const shareQAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 1,
        });
        const shareBAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 2,
        });
        const shareRAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 3,
        });

        const Fund = await ethers.getContractFactory("FundV3");
        const fund = await Fund.connect(owner).deploy([
            btc.address,
            8,
            shareQAddress,
            shareBAddress,
            shareRAddress,
            primaryMarket.address,
            ethers.constants.AddressZero,
            0,
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            interestRateBallot.address,
            feeCollector.address,
        ]);

        const Share = await ethers.getContractFactory("ShareV2");
        const shareQ = await Share.connect(owner).deploy("QUEEN", "Q", fund.address, TRANCHE_Q);
        const shareB = await Share.connect(owner).deploy("BISHOP", "B", fund.address, TRANCHE_B);
        const shareR = await Share.connect(owner).deploy("ROOK", "R", fund.address, TRANCHE_R);

        await advanceBlockAtTime(startDay);
        await fund.initialize(SPLIT_RATIO, parseEther("1"), parseEther("1"));
        const addr1 = user1.address;
        const addr2 = user2.address;
        await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_Q, addr1, INIT_Q_1, 0);
        await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_B, addr1, INIT_B_1, 0);
        await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_R, addr1, INIT_R_1, 0);
        await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_Q, addr2, INIT_Q_2, 0);
        await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_B, addr2, INIT_B_2, 0);
        await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_R, addr2, INIT_R_2, 0);
        await btc.mint(fund.address, INIT_BTC);

        return {
            wallets: { user1, user2 },
            twapOracle,
            shareQ: shareQ.connect(user1),
            shareB: shareB.connect(user1),
            shareR: shareR.connect(user1),
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
        shareQ = fixtureData.shareQ;
        shareB = fixtureData.shareB;
        shareR = fixtureData.shareR;
        addr1 = user1.address;
        addr2 = user2.address;
        twapOracle = fixtureData.twapOracle;
        fund = fixtureData.fund;
    });

    // Trigger a new rebalance with the given price change
    async function mockRebalance(priceChange: BigNumber) {
        const lastPrice = await twapOracle.getTwap(0);
        const newPrice = lastPrice.mul(priceChange).div(parseEther("1"));
        await twapOracle.mock.getTwap.returns(newPrice);
        await advanceOneDayAndSettle();
        await advanceBlockAtTime((await fund.currentDay()).toNumber() - HOUR);
    }

    // NAV before rebalance: (1.1, 2.9)
    // 1 B => 0.00005 Q' + 1 B'
    // 1 R => 0.00095 Q'        + 1 R'
    const preDefinedRebalance200 = () => mockRebalance(parseEther("2"));

    // NAV before rebalance: (1.1, 0.5)
    // 1 B => 0.00075 Q' + 0.5 B'
    // 1 R =>                     + 0.5 R'
    const preDefinedRebalance080 = () => mockRebalance(parseEther("0.8"));

    describe("transfer()", function () {
        it("Should transfer after lower rebalance", async function () {
            await preDefinedRebalance080();

            expect(await shareQ.balanceOf(addr1)).to.equal(parseEther("0.475"));
            expect(await shareQ.balanceOf(addr2)).to.equal(parseEther("0.15"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("50"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("100"));
            expect(await shareR.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareR.balanceOf(addr2)).to.equal(parseEther("150"));

            await expect(shareQ.transfer(addr2, parseEther("0.1")))
                .to.emit(shareQ, "Transfer")
                .withArgs(addr1, addr2, parseEther("0.1"));

            expect(await shareQ.balanceOf(addr1)).to.equal(parseEther("0.375"));
            expect(await shareQ.balanceOf(addr2)).to.equal(parseEther("0.25"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("50"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("100"));
            expect(await shareR.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareR.balanceOf(addr2)).to.equal(parseEther("150"));
        });

        it("Should transfer after upper rebalance", async function () {
            await preDefinedRebalance200();

            expect(await shareQ.balanceOf(addr1)).to.equal(parseEther("0.405"));
            expect(await shareQ.balanceOf(addr2)).to.equal(parseEther("0.295"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareR.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareR.balanceOf(addr2)).to.equal(parseEther("300"));

            await expect(shareQ.transfer(addr2, parseEther("0.1")))
                .to.emit(shareQ, "Transfer")
                .withArgs(addr1, addr2, parseEther("0.1"));

            expect(await shareQ.balanceOf(addr1)).to.equal(parseEther("0.305"));
            expect(await shareQ.balanceOf(addr2)).to.equal(parseEther("0.395"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("200"));
            expect(await shareR.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareR.balanceOf(addr2)).to.equal(parseEther("300"));
        });
    });

    describe("transferFrom()", function () {
        beforeEach(async function () {
            await shareQ.approve(addr2, parseEther("1"));
            await shareB.approve(addr2, parseEther("100"));
            await shareR.approve(addr2, parseEther("100"));
        });

        it("Should rebalance balances and allowances after lower rebalance and transferFrom", async function () {
            await preDefinedRebalance080();
            await expect(shareQ.connect(user2).transferFrom(addr1, addr2, parseEther("0.1")))
                .to.emit(shareQ, "Approval")
                .withArgs(addr1, addr2, parseEther("0.9"));
            await expect(shareB.connect(user2).transferFrom(addr1, addr2, parseEther("1")))
                .to.emit(shareB, "Approval")
                .withArgs(addr1, addr2, parseEther("49"));

            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("0.9"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("49"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("50"));

            expect(await shareQ.balanceOf(addr1)).to.equal(parseEther("0.375"));
            expect(await shareQ.balanceOf(addr2)).to.equal(parseEther("0.25"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("49"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("101"));
            expect(await shareR.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareR.balanceOf(addr2)).to.equal(parseEther("150"));
        });

        it("Should rebalance balances and allowances after upper rebalance and transferFrom", async function () {
            await preDefinedRebalance200();
            await expect(shareQ.connect(user2).transferFrom(addr1, addr2, parseEther("0.1")))
                .to.emit(shareQ, "Approval")
                .withArgs(addr1, addr2, parseEther("0.9"));
            await expect(shareB.connect(user2).transferFrom(addr1, addr2, parseEther("1")))
                .to.emit(shareB, "Approval")
                .withArgs(addr1, addr2, parseEther("99"));

            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("0.9"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("99"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("100"));

            expect(await shareQ.balanceOf(addr1)).to.equal(parseEther("0.305"));
            expect(await shareQ.balanceOf(addr2)).to.equal(parseEther("0.395"));
            expect(await shareB.balanceOf(addr1)).to.equal(parseEther("99"));
            expect(await shareB.balanceOf(addr2)).to.equal(parseEther("201"));
            expect(await shareR.balanceOf(addr1)).to.equal(parseEther("0"));
            expect(await shareR.balanceOf(addr2)).to.equal(parseEther("300"));
        });
    });

    describe("approve()", function () {
        beforeEach(async function () {
            await expect(shareQ.approve(addr2, parseEther("1")))
                .to.emit(shareQ, "Approval")
                .withArgs(addr1, addr2, parseEther("1"));
            await expect(shareB.approve(addr2, parseEther("100")))
                .to.emit(shareB, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
            await expect(shareR.approve(addr2, parseEther("100")))
                .to.emit(shareR, "Approval")
                .withArgs(addr1, addr2, parseEther("100"));
        });

        it("Should rebalance for extremely large allowance", async function () {
            await shareQ.approve(addr2, MAX_UINT256);
            await shareB.approve(addr2, MAX_UINT256);
            await shareR.approve(addr2, MAX_UINT256);

            await preDefinedRebalance080();

            expect(await shareQ.allowance(addr1, addr2)).to.equal(MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareR.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);

            await shareQ.approve(addr2, MAX_UINT256);
            await shareB.approve(addr2, MAX_UINT256);
            await shareR.approve(addr2, MAX_UINT256);

            await preDefinedRebalance200();

            expect(await shareQ.allowance(addr1, addr2)).to.equal(MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareR.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
        });

        it("Should rebalance allowance after lower rebalance", async function () {
            await preDefinedRebalance080();

            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("1"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("50"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("50"));
        });

        it("Should rebalance allowance after upper rebalance", async function () {
            await preDefinedRebalance200();

            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("1"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("100"));
        });
    });

    describe("increaseAllowance()/decreaseAllowance()", function () {
        beforeEach(async function () {
            await shareQ.increaseAllowance(addr2, parseEther("2"));
            await shareB.increaseAllowance(addr2, parseEther("200"));
            await shareR.increaseAllowance(addr2, parseEther("200"));

            await shareQ.decreaseAllowance(addr2, parseEther("1"));
            await shareB.decreaseAllowance(addr2, parseEther("100"));
            await shareR.decreaseAllowance(addr2, parseEther("100"));
        });

        it("Should rebalance for extremely large allowance", async function () {
            await shareQ.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("1")));
            await shareB.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));
            await shareR.increaseAllowance(addr2, MAX_UINT256.sub(parseEther("100")));

            await preDefinedRebalance200();

            expect(await shareQ.allowance(addr1, addr2)).to.equal(MAX_UINT256);
            expect(await shareB.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
            expect(await shareR.allowance(addr1, addr2)).to.equal(SUB_MAX_UINT256);
        });

        it("Should rebalance allowance after lower rebalance then upper rebalance", async function () {
            await preDefinedRebalance080();
            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("1"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("50"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("50"));

            await preDefinedRebalance200();
            await shareQ.decreaseAllowance(addr2, parseEther("0.1"));
            await shareB.decreaseAllowance(addr2, parseEther("1"));
            await shareR.decreaseAllowance(addr2, parseEther("1"));

            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("0.9"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("49"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("49"));
        });

        it("Should rebalance allowance after upper rebalance then lower rebalance", async function () {
            await preDefinedRebalance200();
            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("1"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("100"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("100"));

            await preDefinedRebalance080();
            await shareQ.decreaseAllowance(addr2, parseEther("0.1"));
            await shareB.decreaseAllowance(addr2, parseEther("1"));
            await shareR.decreaseAllowance(addr2, parseEther("1"));

            expect(await shareQ.allowance(addr1, addr2)).to.equal(parseEther("0.9"));
            expect(await shareB.allowance(addr1, addr2)).to.equal(parseEther("49"));
            expect(await shareR.allowance(addr1, addr2)).to.equal(parseEther("49"));
        });
    });

    describe("fundEmitTransfer()", function () {
        it("Should revert if not called by fund", async function () {
            await expect(shareQ.fundEmitTransfer(addr1, addr2, 1)).to.be.revertedWith("Only fund");
        });
    });

    describe("fundEmitApproval()", function () {
        it("Should revert if not called by fund", async function () {
            await expect(shareQ.fundEmitApproval(addr1, addr2, 1)).to.be.revertedWith("Only fund");
        });
    });
});
