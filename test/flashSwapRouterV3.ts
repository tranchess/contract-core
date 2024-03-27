import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import {
    TRANCHE_Q,
    TRANCHE_B,
    TRANCHE_R,
    DAY,
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
} from "./utils";

const UNIT = parseEther("1");
const WEIGHT_B = 9;
const REDEMPTION_FEE_BPS = 100;
const MERGE_FEE_BPS = 75;
const AMPL = 80;
const FEE_RATE = parseEther("0.03");
const ADMIN_FEE_RATE = parseEther("0.4");

const INIT_PRICE = parseEther("1.1");
const INIT_SPLIT_RATIO = parseEther("0.11");
const USER_STETH = parseEther("1000");
const LP_B = parseEther("10000");
const LP_STETH = parseEther("11000");

describe("FlashSwapRouterV3", function () {
    this.timeout(60000);

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly steth: Contract;
        readonly wsteth: Contract;
        readonly fund: Contract;
        readonly stableSwap: Contract;
        readonly primaryMarketRouter: Contract;
        readonly flashSwapRouter: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let steth: Contract;
    let wsteth: Contract;
    let fund: Contract;
    let stableSwap: Contract;
    let primaryMarketRouter: Contract;
    let flashSwapRouter: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const lastDay = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        const startDay = lastDay + DAY;
        await advanceBlockAtTime(lastDay + DAY / 2);

        const MockStETH = await ethers.getContractFactory("MockToken");
        const steth = await MockStETH.connect(owner).deploy("stETH", "stETH", 18);
        await steth.mint(user1.address, USER_STETH.mul(2));
        await steth.mint(user2.address, USER_STETH);

        const MockWstETH = await ethers.getContractFactory("MockWstETH");
        const wsteth = await MockWstETH.connect(owner).deploy(steth.address);
        await wsteth.update(UNIT);
        await steth.connect(user1).approve(wsteth.address, USER_STETH);
        await steth.connect(user2).approve(wsteth.address, USER_STETH);
        await wsteth.connect(user1).wrap(USER_STETH);
        await wsteth.connect(user2).wrap(USER_STETH);

        const twapOracle = await deployMockForName(owner, "ITwapOracleV2");
        await twapOracle.mock.getTwap.withArgs(lastDay).returns(INIT_PRICE);
        await twapOracle.mock.getLatest.returns(INIT_PRICE);
        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(0);

        const fundAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 3,
        });
        const primaryMarketAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 4,
        });
        const Share = (await ethers.getContractFactory("ShareV2")).connect(owner);
        const shareQ = await Share.deploy("wstETH Queen", "QUEEN", fundAddress, TRANCHE_Q);
        const shareB = await Share.deploy("wstETH Bishop", "BISHOP", fundAddress, TRANCHE_B);
        const shareR = await Share.deploy("wstETH Rook", "ROOK", fundAddress, TRANCHE_R);
        const Fund = await ethers.getContractFactory("FundV5");
        const fund = await Fund.connect(owner).deploy([
            WEIGHT_B,
            365 * DAY,
            wsteth.address,
            18,
            shareQ.address,
            shareB.address,
            shareR.address,
            primaryMarketAddress,
            ethers.constants.AddressZero,
            twapOracle.address,
            aprOracle.address,
            feeCollector.address,
        ]);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV5");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
            parseEther("0.0001").mul(MERGE_FEE_BPS),
            BigNumber.from(1).shl(256).sub(1),
            true
        );
        const PrimaryMarketRouter = await ethers.getContractFactory("WstETHPrimaryMarketRouter");
        const primaryMarketRouter = await PrimaryMarketRouter.connect(owner).deploy(
            primaryMarket.address
        );
        await fund.initialize(INIT_SPLIT_RATIO, parseEther("1"), parseEther("1"), 0);

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        await chessSchedule.mock.getRate.returns(UNIT);
        const chessController = await deployMockForName(owner, "ChessControllerV6");
        await chessController.mock.getFundRelativeWeight.returns(UNIT);
        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(1);
        const swapBonus = await deployMockForName(owner, "SwapBonus");
        await swapBonus.mock.bonusToken.returns(ethers.constants.AddressZero);
        await swapBonus.mock.getBonus.returns(0);

        const lpTokenAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 1,
        });
        const StableSwap = await ethers.getContractFactory("WstETHBishopStableSwap");
        const stableSwap = await StableSwap.connect(owner).deploy(
            lpTokenAddress,
            fund.address,
            wsteth.address,
            18,
            AMPL,
            feeCollector.address,
            FEE_RATE,
            ADMIN_FEE_RATE
        );
        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        await LiquidityGauge.connect(owner).deploy(
            "LP Token",
            "LP",
            stableSwap.address,
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address,
            swapBonus.address,
            0
        );

        const wstETH = await deployMockForName(owner, "IWstETH");
        await wstETH.mock.stETH.returns(ethers.constants.AddressZero);
        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy(wstETH.address);
        await swapRouter.addSwap(shareB.address, wsteth.address, stableSwap.address);
        const FlashSwapRouter = await ethers.getContractFactory("FlashSwapRouterV3");
        const flashSwapRouter = await FlashSwapRouter.connect(owner).deploy(swapRouter.address);

        await wsteth.connect(user1).approve(primaryMarketRouter.address, USER_STETH);
        await wsteth.connect(user2).approve(primaryMarketRouter.address, USER_STETH);
        await wsteth.connect(user1).approve(flashSwapRouter.address, USER_STETH);
        await wsteth.connect(user2).approve(flashSwapRouter.address, USER_STETH);
        await steth.connect(user1).approve(flashSwapRouter.address, USER_STETH);

        // Add initial liquidity
        const initQ = LP_B.mul(UNIT).div(INIT_SPLIT_RATIO);
        const initWstETH = initQ;
        await steth.mint(owner.address, initWstETH);
        await steth.approve(wsteth.address, initWstETH);
        await wsteth.wrap(initWstETH);
        await wsteth.approve(primaryMarketRouter.address, initWstETH);
        await primaryMarketRouter.create(owner.address, false, initWstETH, 0, 0);
        await primaryMarket.split(owner.address, initQ, 0);
        await fund.trancheApprove(TRANCHE_B, swapRouter.address, LP_B, 0);
        await steth.mint(owner.address, LP_STETH);
        await steth.approve(wsteth.address, LP_STETH);
        await wsteth.wrap(LP_STETH);
        await wsteth.approve(swapRouter.address, LP_STETH);
        await swapRouter.addLiquidity(
            await fund.tokenShare(TRANCHE_B),
            wsteth.address,
            LP_B,
            LP_STETH,
            0,
            0,
            startDay
        );
        await wsteth.update(INIT_PRICE);

        return {
            wallets: { user1, user2, owner },
            steth,
            wsteth,
            fund: fund.connect(user1),
            stableSwap: stableSwap.connect(user1),
            primaryMarketRouter: primaryMarketRouter.connect(user1),
            flashSwapRouter: flashSwapRouter.connect(user1),
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
        steth = fixtureData.steth;
        wsteth = fixtureData.wsteth;
        fund = fixtureData.fund;
        stableSwap = fixtureData.stableSwap;
        primaryMarketRouter = fixtureData.primaryMarketRouter;
        flashSwapRouter = fixtureData.flashSwapRouter;
    });

    describe("buyR", function () {
        const outR = parseEther("1.1");
        const inQ = outR.mul(UNIT).div(INIT_SPLIT_RATIO);
        const outB = outR.mul(WEIGHT_B);
        const totalQuoteAmount = inQ.mul(1);
        let inWstETH: BigNumber;

        beforeEach(async function () {
            const quoteAmount = await stableSwap.getQuoteOut(outB);
            inWstETH = totalQuoteAmount.sub(quoteAmount);
        });

        it("Should transfer quote and ROOK tokens", async function () {
            await expect(
                flashSwapRouter.buyR(
                    fund.address,
                    false,
                    primaryMarketRouter.address,
                    USER_STETH,
                    addr2,
                    wsteth.address,
                    0,
                    outR
                )
            )
                .to.emit(flashSwapRouter, "SwapRook")
                .withArgs(addr2, 0, inWstETH.add(1), outR, 0);
            expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(outR);
            const spentWstETH = USER_STETH.sub(await wsteth.balanceOf(addr1));
            expect(spentWstETH).to.be.closeTo(inWstETH, inWstETH.div(10000));
        });

        it("Should transfer unwrapped quote and ROOK tokens", async function () {
            const inStETH = inWstETH.mul(INIT_PRICE).div(UNIT);
            await expect(
                flashSwapRouter.buyR(
                    fund.address,
                    true,
                    primaryMarketRouter.address,
                    USER_STETH,
                    addr2,
                    wsteth.address,
                    0,
                    outR
                )
            )
                .to.emit(flashSwapRouter, "SwapRook")
                .withArgs(addr2, 0, inWstETH.add(1), outR, 0);
            expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(outR);
            const spentStETH = USER_STETH.sub(await steth.balanceOf(addr1));
            expect(spentStETH).to.be.closeTo(inStETH, inStETH.div(10000));
        });

        it("Should check maximum input", async function () {
            await expect(
                flashSwapRouter.buyR(
                    fund.address,
                    false,
                    primaryMarketRouter.address,
                    inWstETH.div(2),
                    addr2,
                    wsteth.address,
                    0,
                    outR
                )
            ).to.be.revertedWith("Excessive input");
        });
    });

    describe("sellR", function () {
        const inR = parseEther("1.1");
        const inB = inR.mul(WEIGHT_B);
        const swappedQ = inR
            .mul(UNIT)
            .div(INIT_SPLIT_RATIO)
            .mul(10000 - MERGE_FEE_BPS)
            .div(10000)
            .add(1);
        const totalQuoteAmount = swappedQ
            .mul(10000 - REDEMPTION_FEE_BPS)
            .div(10000)
            .add(1);
        let outWstETH: BigNumber;

        beforeEach(async function () {
            const quoteAmount = await stableSwap.getQuoteIn(inB);
            outWstETH = totalQuoteAmount.sub(quoteAmount);
        });

        it("Should transfer quote and ROOK tokens", async function () {
            await fund.connect(owner).trancheTransfer(TRANCHE_R, addr1, inR, 0);
            await fund.trancheApprove(TRANCHE_R, flashSwapRouter.address, inR, 0);
            await expect(
                flashSwapRouter.sellR(
                    fund.address,
                    false,
                    primaryMarketRouter.address,
                    0,
                    addr2,
                    wsteth.address,
                    0,
                    inR
                )
            )
                .to.emit(flashSwapRouter, "SwapRook")
                .withArgs(addr2, inR, 0, 0, outWstETH.sub(1));
            expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
            const diffWstETH = (await wsteth.balanceOf(addr2)).sub(USER_STETH);
            expect(diffWstETH).to.be.closeTo(outWstETH, outWstETH.div(10000));
        });

        it("Should transfer unwrapped quote and ROOK tokens", async function () {
            const outStETH = outWstETH.mul(INIT_PRICE).div(UNIT);
            await fund.connect(owner).trancheTransfer(TRANCHE_R, addr1, inR, 0);
            await fund.trancheApprove(TRANCHE_R, flashSwapRouter.address, inR, 0);
            await expect(
                flashSwapRouter.sellR(
                    fund.address,
                    true,
                    primaryMarketRouter.address,
                    0,
                    addr2,
                    wsteth.address,
                    0,
                    inR
                )
            )
                .to.emit(flashSwapRouter, "SwapRook")
                .withArgs(addr2, inR, 0, 0, outWstETH.sub(1));
            expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
            expect(await steth.balanceOf(addr2)).to.be.closeTo(outStETH, outStETH.div(10000));
        });

        it("Should check minimum output", async function () {
            await fund.connect(owner).trancheTransfer(TRANCHE_R, addr1, inR, 0);
            await fund.trancheApprove(TRANCHE_R, flashSwapRouter.address, inR, 0);
            await expect(
                flashSwapRouter.sellR(
                    fund.address,
                    false,
                    primaryMarketRouter.address,
                    outWstETH.mul(2),
                    addr2,
                    wsteth.address,
                    0,
                    inR
                )
            ).to.be.revertedWith("Insufficient output");
        });
    });
});
