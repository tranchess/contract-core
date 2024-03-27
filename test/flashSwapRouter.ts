import { expect } from "chai";
import { BigNumber, constants, Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
const parseUsdc = (value: string) => parseUnits(value, 6);
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

const BTC_TO_ETHER = parseUnits("1", 10);
const USDC_TO_ETHER = parseUnits("1", 12);
const UNIT = parseEther("1");
const UPPER_REBALANCE_THRESHOLD = parseEther("2");
const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");
const REDEMPTION_FEE_BPS = 100;
const MERGE_FEE_BPS = 75;
const AMPL = 80;
const FEE_RATE = parseEther("0.03");
const ADMIN_FEE_RATE = parseEther("0.4");

const INIT_PRICE = parseEther("1000");
const INIT_SPLIT_RATIO = INIT_PRICE.div(2);
const USER_BTC = parseBtc("1000");
const USER_USDC = parseUsdc("10000");
const LP_B = parseEther("10000");
const LP_USDC = parseUsdc("10000");

describe("FlashSwapRouter", function () {
    this.timeout(60000);

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly btc: Contract;
        readonly usdc: Contract;
        readonly fund: Contract;
        readonly primaryMarketRouter: Contract;
        readonly externalRouter: Contract;
        readonly flashSwapRouter: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let btc: Contract;
    let usdc: Contract;
    let buyPath: string[];
    let sellPath: string[];
    let fund: Contract;
    let primaryMarketRouter: Contract;
    let externalRouter: Contract;
    let flashSwapRouter: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const lastDay = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        const startDay = lastDay + DAY;
        await advanceBlockAtTime(lastDay + DAY / 2);

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        await btc.mint(user1.address, USER_BTC);
        await btc.mint(user2.address, USER_BTC);
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);
        await usdc.mint(user1.address, USER_USDC);
        await usdc.mint(user2.address, USER_USDC);

        const twapOracle = await deployMockForName(owner, "ITwapOracleV2");
        await twapOracle.mock.getTwap.withArgs(lastDay).returns(INIT_PRICE);
        await twapOracle.mock.getLatest.returns(INIT_PRICE);
        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(0);
        const interestRateBallot = await deployMockForName(owner, "IBallot");
        await interestRateBallot.mock.count.returns(0);

        const fundAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 3,
        });
        const primaryMarketAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 4,
        });
        const Share = (await ethers.getContractFactory("ShareV2")).connect(owner);
        const shareQ = await Share.deploy("BTC Queen", "QUEEN", fundAddress, TRANCHE_Q);
        const shareB = await Share.deploy("BTC Bishop", "BISHOP", fundAddress, TRANCHE_B);
        const shareR = await Share.deploy("BTC Rook", "ROOK", fundAddress, TRANCHE_R);
        const Fund = await ethers.getContractFactory("FundV3");
        const fund = await Fund.connect(owner).deploy([
            btc.address,
            8,
            shareQ.address,
            shareB.address,
            shareR.address,
            primaryMarketAddress,
            ethers.constants.AddressZero,
            0,
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            interestRateBallot.address,
            feeCollector.address,
        ]);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
            parseEther("0.0001").mul(MERGE_FEE_BPS),
            BigNumber.from(1).shl(256).sub(1)
        );
        const PrimaryMarketRouter = await ethers.getContractFactory("PrimaryMarketRouter");
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
        const StableSwap = await ethers.getContractFactory("BishopStableSwapV2");
        const stableSwap = await StableSwap.connect(owner).deploy(
            lpTokenAddress,
            fund.address,
            usdc.address,
            6,
            AMPL,
            feeCollector.address,
            FEE_RATE,
            ADMIN_FEE_RATE,
            parseEther("0.35")
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
        await swapRouter.addSwap(shareB.address, usdc.address, stableSwap.address);
        const MockExternalRouter = await ethers.getContractFactory("MockExternalRouter");
        const externalRouter = await MockExternalRouter.connect(owner).deploy();
        const FlashSwapRouter = await ethers.getContractFactory("FlashSwapRouter");
        const flashSwapRouter = await FlashSwapRouter.connect(owner).deploy(swapRouter.address);
        await flashSwapRouter.toggleExternalRouter(externalRouter.address);
        await btc.mint(externalRouter.address, USER_BTC);
        await usdc.mint(externalRouter.address, USER_USDC);

        await btc.connect(user1).approve(primaryMarketRouter.address, USER_BTC);
        await btc.connect(user2).approve(primaryMarketRouter.address, USER_BTC);
        await usdc.connect(user1).approve(flashSwapRouter.address, USER_USDC);
        await usdc.connect(user2).approve(flashSwapRouter.address, USER_USDC);

        // Add initial liquidity
        const initQ = LP_B.mul(UNIT).div(INIT_SPLIT_RATIO);
        const initBtc = initQ.div(BTC_TO_ETHER);
        await btc.mint(owner.address, initBtc);
        await btc.approve(primaryMarketRouter.address, initBtc);
        await primaryMarketRouter.create(owner.address, initBtc, 0, 0);
        await primaryMarket.split(owner.address, initQ, 0);
        await fund.trancheApprove(TRANCHE_B, swapRouter.address, LP_B, 0);
        await usdc.mint(owner.address, LP_USDC);
        await usdc.approve(swapRouter.address, LP_USDC);
        await swapRouter.addLiquidity(
            await fund.tokenShare(TRANCHE_B),
            usdc.address,
            LP_B,
            LP_USDC,
            0,
            0,
            startDay
        );

        return {
            wallets: { user1, user2, owner },
            btc,
            usdc,
            fund: fund.connect(user1),
            primaryMarketRouter: primaryMarketRouter.connect(user1),
            externalRouter,
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
        btc = fixtureData.btc;
        usdc = fixtureData.usdc;
        buyPath = [usdc.address, btc.address];
        sellPath = [btc.address, usdc.address];
        fund = fixtureData.fund;
        primaryMarketRouter = fixtureData.primaryMarketRouter;
        externalRouter = fixtureData.externalRouter;
        flashSwapRouter = fixtureData.flashSwapRouter;
    });

    describe("buyR", function () {
        const outR = parseEther("1");
        const swappedM = outR.mul(UNIT).div(INIT_SPLIT_RATIO);
        const swappedBtc = swappedM.div(BTC_TO_ETHER);
        const inUsdc = outR.div(USDC_TO_ETHER).mul(UNIT.add(FEE_RATE)).div(UNIT); // TODO div nav
        const swappedUsdc = swappedBtc
            .mul(BTC_TO_ETHER)
            .mul(INIT_PRICE)
            .div(UNIT)
            .div(USDC_TO_ETHER);

        it("Should transfer quote and ROOK tokens", async function () {
            await externalRouter.setNextSwap(buyPath, swappedUsdc, swappedBtc);
            await expect(
                flashSwapRouter.buyR(
                    fund.address,
                    primaryMarketRouter.address,
                    USER_USDC,
                    addr2,
                    usdc.address,
                    externalRouter.address,
                    buyPath,
                    constants.AddressZero,
                    0,
                    outR
                )
            )
                .to.emit(flashSwapRouter, "SwapRook")
                .withArgs(addr2, 0, inUsdc.add(1), outR, 0);
            expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(outR);
            const spentUsdc = USER_USDC.sub(await usdc.balanceOf(addr1));
            expect(spentUsdc).to.be.closeTo(inUsdc, inUsdc.div(10000));
        });

        it("Should check maximum input", async function () {
            await externalRouter.setNextSwap(buyPath, swappedUsdc, swappedBtc);
            await expect(
                flashSwapRouter.buyR(
                    fund.address,
                    primaryMarketRouter.address,
                    inUsdc.div(2),
                    addr2,
                    usdc.address,
                    externalRouter.address,
                    buyPath,
                    constants.AddressZero,
                    0,
                    outR
                )
            ).to.be.revertedWith("Excessive input");
        });
    });

    describe("sellR", function () {
        const inR = parseEther("1");
        const swappedM = inR
            .mul(UNIT)
            .div(INIT_SPLIT_RATIO)
            .mul(10000 - MERGE_FEE_BPS)
            .div(10000);
        const swappedBtc = swappedM
            .mul(10000 - REDEMPTION_FEE_BPS)
            .div(10000)
            .div(BTC_TO_ETHER);
        const swappedUsdc = swappedBtc
            .mul(BTC_TO_ETHER)
            .mul(INIT_PRICE)
            .div(UNIT)
            .div(USDC_TO_ETHER);
        const outUsdc = swappedUsdc.sub(inR.mul(UNIT).div(UNIT.sub(FEE_RATE)).div(USDC_TO_ETHER));

        it("Should transfer quote and ROOK tokens", async function () {
            await fund.connect(owner).trancheTransfer(TRANCHE_R, addr1, inR, 0);
            await fund.trancheApprove(TRANCHE_R, flashSwapRouter.address, inR, 0);
            await externalRouter.setNextSwap(sellPath, swappedBtc, swappedUsdc);
            await expect(
                flashSwapRouter.sellR(
                    fund.address,
                    primaryMarketRouter.address,
                    0,
                    addr2,
                    usdc.address,
                    externalRouter.address,
                    sellPath,
                    0,
                    inR
                )
            )
                .to.emit(flashSwapRouter, "SwapRook")
                .withArgs(addr2, inR, 0, 0, outUsdc.sub(2));
            expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
            const diffUsdc = (await usdc.balanceOf(addr2)).sub(USER_USDC);
            expect(diffUsdc).to.be.closeTo(outUsdc, outUsdc.div(10000));
        });

        it("Should check minimum output", async function () {
            await fund.connect(owner).trancheTransfer(TRANCHE_R, addr1, inR, 0);
            await fund.trancheApprove(TRANCHE_R, flashSwapRouter.address, inR, 0);
            await externalRouter.setNextSwap(sellPath, swappedBtc, swappedUsdc);
            await expect(
                flashSwapRouter.sellR(
                    fund.address,
                    primaryMarketRouter.address,
                    outUsdc.mul(2),
                    addr2,
                    usdc.address,
                    externalRouter.address,
                    sellPath,
                    0,
                    inR
                )
            ).to.be.revertedWith("Insufficient output");
        });
    });
});
