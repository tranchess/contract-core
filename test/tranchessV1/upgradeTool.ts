import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
const parseUsdc = (value: string) => parseUnits(value, 6);
import { deployMockForName } from "../mock";
import {
    TRANCHE_M,
    TRANCHE_A,
    TRANCHE_B,
    HOUR,
    DAY,
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
} from "./utils";

const BTC_TO_ETHER = parseUnits("1", 10);
const UPPER_REBALANCE_THRESHOLD = parseEther("2");
const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");
const REDEMPTION_FEE_BPS = 40;
const MERGE_FEE_BPS = 30;
const DAILY_PROTOCOL_FEE_BPS = 1; // 0.01% per day
const INTEREST_RATE_BPS = 10; // 0.1% per day

describe("UpgradeTool", function () {
    this.timeout(60000); // The deployment fixture is complex and slow

    interface ContractMap {
        readonly [name: string]: Contract;
    }

    interface MockContractMap {
        readonly [name: string]: MockContract;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly contracts: ContractMap;
        readonly mockContracts: MockContractMap;
        readonly startDay: number;
        readonly upgradeDay: number;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let startDay: number;
    let upgradeDay: number;
    let btc: Contract;
    let twapOracle: MockContract;
    let chessSchedule: MockContract;
    let oldFund: Contract;
    let oldShareM: Contract;
    let oldShareA: Contract;
    let oldShareB: Contract;
    let oldPrimaryMarket: Contract;
    let newFund: Contract;
    let newShareM: Contract;
    let newShareA: Contract;
    let newShareB: Contract;
    let newStaking: Contract;
    let upgradeTool: Contract;

    let upgradeUnderlying: BigNumber;
    let upgradeNavA: BigNumber;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector, strategy] = provider.getWallets();

        // Create shares on Thursday and upgrade on the next Thursday
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startDay = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        const upgradeDay = startDay + WEEK;
        await advanceBlockAtTime(startDay - HOUR * 12);

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        await btc.mint(user1.address, parseBtc("10000"));
        await btc.mint(user2.address, parseBtc("10000"));
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);
        await usdc.mint(user1.address, parseUsdc("10000"));
        await usdc.mint(user2.address, parseUsdc("10000"));
        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        await twapOracle.mock.getTwap.returns(parseEther("1000"));
        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(parseEther("0.0001").mul(INTEREST_RATE_BPS));
        const interestRateBallot = await deployMockForName(owner, "IBallot");
        await interestRateBallot.mock.count.returns(0);
        const chessSchedule = await deployMockForName(owner, "IChessSchedule");
        await chessSchedule.mock.getRate.returns(0);
        const chessController = await deployMockForName(owner, "IChessController");
        await chessController.mock.getFundRelativeWeight.returns(parseEther("0.5"));
        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();

        // Deploy the old fund
        const OldFund = await ethers.getContractFactory("FundV2");
        const oldFund = await OldFund.connect(owner).deploy(
            btc.address,
            8,
            parseEther("0.0001").mul(DAILY_PROTOCOL_FEE_BPS),
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            interestRateBallot.address,
            feeCollector.address
        );
        const Share = await ethers.getContractFactory("Share");
        const oldShareM = await Share.connect(owner).deploy("M", "M", oldFund.address, TRANCHE_M);
        const oldShareA = await Share.connect(owner).deploy("A", "A", oldFund.address, TRANCHE_A);
        const oldShareB = await Share.connect(owner).deploy("B", "B", oldFund.address, TRANCHE_B);
        const OldPrimaryMarket = await ethers.getContractFactory("PrimaryMarketV2");
        const oldPrimaryMarket = await OldPrimaryMarket.connect(owner).deploy(
            oldFund.address,
            0,
            0,
            0,
            0,
            BigNumber.from(1).shl(256).sub(1)
        );
        await oldFund.initialize(
            oldShareM.address,
            oldShareA.address,
            oldShareB.address,
            oldPrimaryMarket.address,
            strategy.address
        );

        // Deploy the old exchange
        const ExchangeV2 = await ethers.getContractFactory("ExchangeV2");
        const oldExchangeImpl = await ExchangeV2.connect(owner).deploy(
            oldFund.address,
            chessSchedule.address,
            chessController.address,
            usdc.address,
            6,
            votingEscrow.address,
            0,
            0,
            0,
            0,
            0
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const exchangeProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            oldExchangeImpl.address,
            proxyAdmin.address,
            (
                await oldExchangeImpl.populateTransaction.initialize()
            ).data
        );
        const oldExchange = ExchangeV2.attach(exchangeProxy.address);

        // Deploy the new fund
        const newFundAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 3,
        });
        const upgradeToolAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 5,
        });
        const NewShare = await ethers.getContractFactory("ShareV2");
        const newShareM = await NewShare.connect(owner).deploy("Q", "Q", newFundAddress, TRANCHE_M);
        const newShareA = await NewShare.connect(owner).deploy("B", "B", newFundAddress, TRANCHE_A);
        const newShareB = await NewShare.connect(owner).deploy("R", "R", newFundAddress, TRANCHE_B);
        const NewFund = await ethers.getContractFactory("FundV3");
        const newFund = await NewFund.connect(owner).deploy([
            btc.address,
            8,
            newShareM.address,
            newShareA.address,
            newShareB.address,
            upgradeToolAddress,
            ethers.constants.AddressZero,
            0,
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            interestRateBallot.address,
            feeCollector.address,
        ]);
        const NewShareStaking = await ethers.getContractFactory("ShareStaking");
        const newStaking = await NewShareStaking.connect(owner).deploy(
            newFund.address,
            chessSchedule.address,
            chessController.address,
            votingEscrow.address,
            upgradeDay + DAY
        );
        const UpgradeTool = await ethers.getContractFactory("UpgradeTool");
        const upgradeTool = await UpgradeTool.connect(owner).deploy(
            oldFund.address,
            2,
            oldExchange.address,
            newFund.address,
            newStaking.address,
            upgradeDay
        );

        const NewPrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
        const newPrimaryMarket = await NewPrimaryMarket.connect(owner).deploy(
            newFund.address,
            parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
            parseEther("0.0001").mul(MERGE_FEE_BPS),
            BigNumber.from(1).shl(256).sub(1)
        );
        const NewPrimaryMarketRouter = await ethers.getContractFactory("PrimaryMarketRouter");
        const newPrimaryMarketRouter = await NewPrimaryMarketRouter.connect(owner).deploy(
            newPrimaryMarket.address
        );

        // Prepare creations, redemptions and staking
        await btc.connect(user1).approve(oldPrimaryMarket.address, parseBtc("10000"));
        await btc.connect(user2).approve(oldPrimaryMarket.address, parseBtc("10000"));
        await oldPrimaryMarket.connect(user1).create(parseBtc("8")); // 8000 M
        await oldPrimaryMarket.connect(user2).create(parseBtc("2")); // 2000 M
        await advanceBlockAtTime(startDay);
        await oldFund.settle();
        await oldPrimaryMarket.claim(user1.address); // 8000 M
        await oldPrimaryMarket.connect(user1).redeem(parseEther("1000"));
        await oldPrimaryMarket.connect(user1).split(parseEther("4000"));
        await oldShareM.connect(user1).approve(oldExchange.address, parseEther("1000000"));
        await oldShareA.connect(user1).approve(oldExchange.address, parseEther("1000000"));
        await oldShareB.connect(user1).approve(oldExchange.address, parseEther("1000000"));
        await oldExchange.connect(user1).deposit(TRANCHE_M, parseEther("2000"));
        await oldExchange.connect(user1).deposit(TRANCHE_A, parseEther("1500"));
        await oldExchange.connect(user1).deposit(TRANCHE_B, parseEther("500"));

        // Prepare orders and trades
        await usdc.connect(user1).approve(oldExchange.address, parseUsdc("10000"));
        await usdc.connect(user2).approve(oldExchange.address, parseUsdc("10000"));
        await oldExchange.connect(user1).placeBid(TRANCHE_M, 41, parseEther("100"), 0);

        // Enter the stage START
        await advanceBlockAtTime(upgradeDay - DAY - HOUR);
        for (let i = 0; i < (upgradeDay - startDay) / DAY - 2; i++) {
            await oldFund.settle();
        }
        await oldFund.addObsoletePrimaryMarket(oldPrimaryMarket.address);
        await oldFund.addNewPrimaryMarket(upgradeTool.address);
        await oldFund.updateTwapOracle(upgradeTool.address);
        await oldFund.updateAprOracle(upgradeTool.address);
        await oldFund.updateBallot(upgradeTool.address);
        await newFund.transferOwnership(upgradeTool.address);
        const ExchangeV3 = await ethers.getContractFactory("ExchangeV3");
        const oldExchangeImplForUpgrade = await ExchangeV3.connect(owner).deploy(
            oldFund.address,
            chessSchedule.address,
            chessController.address,
            usdc.address,
            6,
            votingEscrow.address,
            0,
            0,
            0,
            0,
            upgradeTool.address
        );
        await proxyAdmin.upgrade(oldExchange.address, oldExchangeImplForUpgrade.address);
        await advanceBlockAtTime(upgradeDay - DAY);
        await oldFund.settle();

        return {
            wallets: { user1, user2, owner },
            contracts: {
                btc,
                oldFund: oldFund.connect(user1),
                oldShareM: oldShareM.connect(user1),
                oldShareA: oldShareA.connect(user1),
                oldShareB: oldShareB.connect(user1),
                oldPrimaryMarket: oldPrimaryMarket.connect(user1),
                newFund: newFund.connect(user1),
                newShareM,
                newShareA,
                newShareB,
                newPrimaryMarketRouter: newPrimaryMarketRouter.connect(user1),
                newStaking: newStaking.connect(user1),
                upgradeTool: upgradeTool.connect(user1),
            },
            mockContracts: {
                twapOracle,
                chessSchedule,
                votingEscrow,
            },
            startDay,
            upgradeDay,
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
        startDay = fixtureData.startDay;
        upgradeDay = fixtureData.upgradeDay;
        btc = fixtureData.contracts.btc;
        twapOracle = fixtureData.mockContracts.twapOracle;
        chessSchedule = fixtureData.mockContracts.chessSchedule;
        oldFund = fixtureData.contracts.oldFund;
        oldShareM = fixtureData.contracts.oldShareM;
        oldShareA = fixtureData.contracts.oldShareA;
        oldShareB = fixtureData.contracts.oldShareB;
        oldPrimaryMarket = fixtureData.contracts.oldPrimaryMarket;
        newFund = fixtureData.contracts.newFund;
        newShareM = fixtureData.contracts.newShareM;
        newShareA = fixtureData.contracts.newShareA;
        newShareB = fixtureData.contracts.newShareB;
        newStaking = fixtureData.contracts.newStaking;
        upgradeTool = fixtureData.contracts.upgradeTool;

        upgradeUnderlying = parseBtc("9");
        upgradeNavA = parseEther("1");
        for (let i = 0; i < (upgradeDay - startDay) / DAY; i++) {
            upgradeUnderlying = upgradeUnderlying.sub(
                upgradeUnderlying.mul(DAILY_PROTOCOL_FEE_BPS).div(10000)
            );
            upgradeNavA = upgradeNavA
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000)
                .mul(10000 + INTEREST_RATE_BPS)
                .div(10000);
        }
    });

    async function goToStageSettled(): Promise<void> {
        await advanceBlockAtTime(upgradeDay);
        await oldFund.settle();
    }

    async function goToStageUpgraded(): Promise<void> {
        if ((await upgradeTool.stage()).toNumber() === 0) {
            await goToStageSettled();
        }
        await upgradeTool.connect(owner).createNewTokens();
    }

    describe("Stage START", function () {
        it("Should reject primary market operations", async function () {
            await expect(oldPrimaryMarket.create(parseBtc("1"))).to.be.revertedWith(
                "Only when active"
            );
            await expect(oldPrimaryMarket.split(parseEther("1"))).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should allow claiming old creations and redemptions", async function () {
            await expect(() => oldPrimaryMarket.claim(addr1)).to.changeTokenBalance(
                btc,
                user1,
                parseBtc("1")
                    .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                    .div(10000)
            );
            await expect(() => oldPrimaryMarket.claim(addr2)).to.changeTokenBalance(
                oldShareM,
                user2,
                parseEther("2000")
            );
        });
    });

    describe("Stage START to SETTLED", function () {
        it("Should revert if not twap oracle of the old fund", async function () {
            await oldFund.connect(owner).updateTwapOracle(twapOracle.address);
            await advanceBlockAtTime(upgradeDay);
            await expect(oldFund.settle()).to.be.revertedWith("Not TWAP oracle of the old fund");
        });

        it("Should record total underlying and change stage", async function () {
            await goToStageSettled();
            expect(await upgradeTool.upgradeUnderlying()).to.equal(upgradeUnderlying);
            expect(await upgradeTool.stage()).to.equal(1);
        });

        it("Should fetch underlying from the old fund", async function () {
            await goToStageSettled();
            expect(await btc.balanceOf(oldFund.address)).to.equal(1);
            expect(await btc.balanceOf(upgradeTool.address)).to.equal(upgradeUnderlying.sub(1));
        });

        it("Should keep NAV the same as before", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1200"));
            await goToStageSettled();
            const totalValue = upgradeUnderlying.mul(BTC_TO_ETHER).mul(parseEther("1200"));
            const totalShares = parseEther("9000");
            const navs = await oldFund.historicalNavs(upgradeDay);
            expect(navs[0]).to.equal(totalValue.div(totalShares));
            expect(navs[1]).to.equal(upgradeNavA);
        });

        it("Upper rebalance on upgrade", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("2000"));
            await goToStageSettled();
            const upgradeNavM = upgradeUnderlying
                .mul(BTC_TO_ETHER)
                .mul(parseEther("2000"))
                .div(parseEther("9000"));
            const rebalance = await oldFund.getRebalance(0);
            expect(rebalance.ratioM).to.equal(upgradeNavM);
        });

        it("Lower rebalance on upgrade", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("700"));
            await goToStageSettled();
            const upgradeNavM = upgradeUnderlying
                .mul(BTC_TO_ETHER)
                .mul(parseEther("700"))
                .div(parseEther("9000"));
            const rebalance = await oldFund.getRebalance(0);
            expect(rebalance.ratioM).to.equal(upgradeNavM);
        });
    });

    describe("Stage SETTLED", function () {
        beforeEach(async function () {
            await goToStageSettled();
        });

        it("Should keep NAV of the old fund unchanged on price change", async function () {
            const upgradeNavs = await oldFund.historicalNavs(upgradeDay);
            await twapOracle.mock.getTwap.withArgs(upgradeDay + DAY).returns(parseEther("1200"));
            await advanceBlockAtTime(upgradeDay + DAY);
            await oldFund.settle();
            const newNavs = await oldFund.historicalNavs(upgradeDay + DAY);
            expect(newNavs[0]).to.equal(upgradeNavs[0]);
            expect(newNavs[1]).to.equal(upgradeNavs[1]);
            expect(newNavs[2]).to.equal(upgradeNavs[2]);
        });

        it("Should keep NAV of the old fund unchanged on underlying transfer", async function () {
            const upgradeNavs = await oldFund.historicalNavs(upgradeDay);
            await btc.mint(oldFund.address, parseBtc("100"));
            await advanceBlockAtTime(upgradeDay + DAY);
            await oldFund.settle();
            const newNavs = await oldFund.historicalNavs(upgradeDay + DAY);
            expect(newNavs[0]).to.equal(upgradeNavs[0]);
            expect(newNavs[1]).to.equal(upgradeNavs[1]);
            expect(newNavs[2]).to.equal(upgradeNavs[2]);
        });
    });

    describe("Stage SETTLED to UPGRADED", function () {
        it("Should revert if not called by owner", async function () {
            await goToStageSettled();
            await expect(upgradeTool.createNewTokens()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should revert if not in stage SETTLED", async function () {
            await expect(upgradeTool.connect(owner).createNewTokens()).to.be.revertedWith(
                "Incorrect stage"
            );
            await goToStageUpgraded();
            await expect(upgradeTool.connect(owner).createNewTokens()).to.be.revertedWith(
                "Incorrect stage"
            );
        });

        it("Should initialize the new fund", async function () {
            await goToStageUpgraded();
            const upgradeNavs = await oldFund.historicalNavs(upgradeDay);
            expect(await newFund.splitRatio()).to.equal(parseEther("500")); // Half of the TWAP
            const navs = await newFund.historicalNavs(upgradeDay);
            expect(navs[0]).to.equal(upgradeNavs[1]);
            expect(navs[1]).to.equal(upgradeNavs[2]);
        });

        it("Should return ownership of the new fund", async function () {
            await goToStageUpgraded();
            expect(await newFund.owner()).to.equal(owner.address);
        });

        it("Should transfer underlying tokens to the new fund", async function () {
            await goToStageSettled();
            await expect(() => upgradeTool.connect(owner).createNewTokens()).to.changeTokenBalances(
                btc,
                [upgradeTool, newFund],
                [upgradeUnderlying.sub(1).mul(-1), upgradeUnderlying.sub(1)]
            );
        });

        it("Should mint new shares", async function () {
            await goToStageUpgraded();
            expect(await newShareM.balanceOf(upgradeTool.address)).to.equal(parseEther("5"));
            expect(await newShareA.balanceOf(upgradeTool.address)).to.equal(parseEther("2000"));
            expect(await newShareB.balanceOf(upgradeTool.address)).to.equal(parseEther("2000"));
            expect(await newShareM.totalSupply()).to.equal(parseEther("5"));
            expect(await newShareA.totalSupply()).to.equal(parseEther("2000"));
            expect(await newShareB.totalSupply()).to.equal(parseEther("2000"));
        });

        it("Should change stage", async function () {
            await goToStageUpgraded();
            expect(await upgradeTool.stage()).to.equal(2);
        });
    });

    describe("Stage UPGRADED", function () {
        it("Should not upgrade shares in smart contracts", async function () {
            await goToStageUpgraded();
            await expect(upgradeTool.protocolUpgrade(oldPrimaryMarket.address)).to.be.revertedWith(
                "Smart contracts can only be upgraded by itself or admin"
            );
            await expect(upgradeTool.protocolUpgrade(upgradeTool.address)).to.be.revertedWith(
                "Smart contracts can only be upgraded by itself or admin"
            );
        });

        it("Should return amount of new shares and claimed CHESS", async function () {
            await goToStageUpgraded();
            await chessSchedule.mock.mint.returns();
            const ret1 = await upgradeTool.callStatic.protocolUpgrade(addr1);
            expect(ret1.amountM).to.equal(parseEther("3"));
            expect(ret1.amountA).to.equal(parseEther("2000"));
            expect(ret1.amountB).to.equal(parseEther("2000"));
            expect(ret1.claimedRewards).to.equal(0);
            const ret2 = await upgradeTool.callStatic.protocolUpgrade(addr2);
            expect(ret2.amountM).to.equal(0); // User2's creation is not claimed yet
            expect(ret2.amountA).to.equal(0);
            expect(ret2.amountB).to.equal(0);
            expect(ret2.claimedRewards).to.equal(0);

            await oldPrimaryMarket.claim(addr2);
            const ret2ag = await upgradeTool.callStatic.protocolUpgrade(addr2);
            expect(ret2ag.amountM).to.equal(parseEther("2"));
            expect(ret2ag.amountA).to.equal(0);
            expect(ret2ag.amountB).to.equal(0);
            expect(ret2ag.claimedRewards).to.equal(0);
        });

        it("Should transfer old tokens to the upgrade tool", async function () {
            const totalSupplyM = await oldShareM.totalSupply();
            const totalSupplyA = await oldShareA.totalSupply();
            const totalSupplyB = await oldShareB.totalSupply();

            await goToStageUpgraded();
            await chessSchedule.mock.mint.returns();
            await upgradeTool.protocolUpgrade(addr1);
            expect(await oldShareM.balanceOf(upgradeTool.address)).to.equal(parseEther("3000"));
            expect(await oldShareA.balanceOf(upgradeTool.address)).to.equal(parseEther("2000"));
            expect(await oldShareB.balanceOf(upgradeTool.address)).to.equal(parseEther("2000"));

            await oldPrimaryMarket.claim(addr2);
            await upgradeTool.protocolUpgrade(addr2);
            expect(await oldShareM.balanceOf(upgradeTool.address)).to.equal(parseEther("5000"));
            expect(await oldShareA.balanceOf(upgradeTool.address)).to.equal(parseEther("2000"));
            expect(await oldShareB.balanceOf(upgradeTool.address)).to.equal(parseEther("2000"));

            expect(await oldShareM.totalSupply()).to.equal(totalSupplyM);
            expect(await oldShareA.totalSupply()).to.equal(totalSupplyA);
            expect(await oldShareB.totalSupply()).to.equal(totalSupplyB);
        });

        it("Should stake new shares", async function () {
            await goToStageUpgraded();
            await chessSchedule.mock.mint.returns();
            await upgradeTool.protocolUpgrade(addr1);
            expect(await newStaking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(parseEther("3"));
            expect(await newStaking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(
                parseEther("2000")
            );
            expect(await newStaking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(
                parseEther("2000")
            );
            expect(await newStaking.totalSupply(TRANCHE_M)).to.equal(parseEther("3"));
            expect(await newStaking.totalSupply(TRANCHE_A)).to.equal(parseEther("2000"));
            expect(await newStaking.totalSupply(TRANCHE_B)).to.equal(parseEther("2000"));

            await oldPrimaryMarket.claim(addr2);
            await upgradeTool.protocolUpgrade(addr2);
            expect(await newStaking.trancheBalanceOf(TRANCHE_M, addr2)).to.equal(parseEther("2"));
            expect(await newStaking.trancheBalanceOf(TRANCHE_A, addr2)).to.equal(0);
            expect(await newStaking.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(0);
            expect(await newStaking.totalSupply(TRANCHE_M)).to.equal(parseEther("5"));
            expect(await newStaking.totalSupply(TRANCHE_A)).to.equal(parseEther("2000"));
            expect(await newStaking.totalSupply(TRANCHE_B)).to.equal(parseEther("2000"));
        });
    });
});
