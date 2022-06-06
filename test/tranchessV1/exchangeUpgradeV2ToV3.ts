import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
import { deployMockForName } from "../mock";
import {
    TRANCHE_M,
    TRANCHE_A,
    TRANCHE_B,
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";
import {
    REWARD_WEIGHT_M,
    REWARD_WEIGHT_A,
    REWARD_WEIGHT_B,
    boostedWorkingBalance,
} from "./stakingV2Formula";

const EPOCH = 1800; // 30 min
const USDC_TO_ETHER = parseUnits("1", 12);
const MAKER_RESERVE_M_BPS = 10500; // 105%
const MAKER_RESERVE_A_BPS = 10010; // 100.1%
const MAKER_RESERVE_B_BPS = 11000; // 110%
const MIN_BID_AMOUNT = parseEther("0.8");
const MIN_ASK_AMOUNT = parseEther("0.9");

const USER1_USDC = parseEther("100000");
const USER2_USDC = parseEther("200000");

// Initial balance:
// User 1: 400 M + 120 A + 180 B
// User 2:         180 A + 120 B
// Reward weight:
// User 1: 400   + 160   + 120   = 680
// User 2:         240   +  80   = 320
// Total : 400   + 400   + 200   = 1000
const USER1_M = parseEther("400");
const USER1_A = parseEther("120");
const USER1_B = parseEther("180");
const USER2_M = parseEther("0");
const USER2_A = parseEther("180");
const USER2_B = parseEther("120");
const TOTAL_M = USER1_M.add(USER2_M);
const TOTAL_A = USER1_A.add(USER2_A);
const TOTAL_B = USER1_B.add(USER2_B);
const USER1_WEIGHT = USER1_M.mul(REWARD_WEIGHT_M)
    .add(USER1_A.mul(REWARD_WEIGHT_A))
    .add(USER1_B.mul(REWARD_WEIGHT_B))
    .div(REWARD_WEIGHT_M);
const USER2_WEIGHT = USER2_M.mul(REWARD_WEIGHT_M)
    .add(USER2_A.mul(REWARD_WEIGHT_A))
    .add(USER2_B.mul(REWARD_WEIGHT_B))
    .div(REWARD_WEIGHT_M);
const TOTAL_WEIGHT = USER1_WEIGHT.add(USER2_WEIGHT);

// veCHESS proportion:
// User 1: 30%
// User 2: 70%
// Boosted staking weight:
// User 1: 680 + 1000 * 30% * (3 - 1) = 1280
// User 2: 320 * 3 = 960
// Total : 1280 + 960 = 2240
const USER1_VE = parseEther("0.03");
const USER2_VE = parseEther("0.07");
const TOTAL_VE = parseEther("0.1");
const USER1_VE_PROPORTION = USER1_VE.mul(parseEther("1")).div(TOTAL_VE);
const USER2_VE_PROPORTION = USER2_VE.mul(parseEther("1")).div(TOTAL_VE);

const USER1_WORKING_BALANCE = boostedWorkingBalance(
    USER1_M,
    USER1_A,
    USER1_B,
    TOTAL_WEIGHT,
    USER1_VE_PROPORTION
);
const USER2_WORKING_BALANCE = boostedWorkingBalance(
    USER2_M,
    USER2_A,
    USER2_B,
    TOTAL_WEIGHT,
    USER2_VE_PROPORTION
);
const WORKING_SUPPLY = USER1_WORKING_BALANCE.add(USER2_WORKING_BALANCE);

const ASK_1_PD_2 = parseEther("6");
const ASK_1_PD_1 = parseEther("2");
const ASK_2_PD_1 = parseEther("3");
const ASK_3_PD_1 = parseEther("5");
const ASK_1_PD_0 = parseEther("4");
const BID_1_PD_0 = parseEther("10");

describe("Exchange upgrade V2 to V3", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startEpoch: number;
        readonly upgradeEpoch: number;
        readonly fund: MockContract;
        readonly shareM: MockContract;
        readonly shareA: MockContract;
        readonly shareB: MockContract;
        readonly chessSchedule: MockContract;
        readonly usdc: Contract;
        readonly upgradeTool: MockContract;
        readonly proxyAdmin: Contract;
        readonly exchange: Contract;
        readonly exchangeV3Impl: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let addr1: string;
    let addr2: string;
    let startEpoch: number;
    let upgradeEpoch: number;
    let fund: MockContract;
    let shareM: MockContract;
    let shareA: MockContract;
    let shareB: MockContract;
    let chessSchedule: MockContract;
    let usdc: Contract;
    let upgradeTool: MockContract;
    let proxyAdmin: Contract;
    let exchange: Contract;
    let exchangeV3Impl: Contract;

    async function upgradeToV3(): Promise<void> {
        await proxyAdmin.upgrade(exchange.address, exchangeV3Impl.address);
        exchange = await ethers.getContractAt("ExchangeV3", exchange.address);
    }

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        let startEpoch = (await ethers.provider.getBlock("latest")).timestamp;
        startEpoch = Math.ceil(startEpoch / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        await advanceBlockAtTime(startEpoch - EPOCH * 10);

        const fund = await deployMockForName(owner, "IFund");
        const shareM = await deployMockForName(owner, "IERC20");
        const shareA = await deployMockForName(owner, "IERC20");
        const shareB = await deployMockForName(owner, "IERC20");
        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        await fund.mock.tokenM.returns(shareM.address);
        await fund.mock.tokenA.returns(shareA.address);
        await fund.mock.tokenB.returns(shareB.address);
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.twapOracle.returns(twapOracle.address);
        await fund.mock.isExchangeActive.returns(true);
        await twapOracle.mock.getTwap.returns(parseEther("1000"));

        const chessSchedule = await deployMockForName(owner, "IChessSchedule");
        await chessSchedule.mock.getRate.returns(0);

        const chessController = await deployMockForName(owner, "IChessController");
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");

        const Exchange = await ethers.getContractFactory("ExchangeV2");
        const exchangeImpl = await Exchange.connect(owner).deploy(
            fund.address,
            chessSchedule.address,
            chessController.address,
            usdc.address,
            6,
            votingEscrow.address,
            MIN_BID_AMOUNT,
            MIN_ASK_AMOUNT,
            0,
            0,
            0
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const initTx = await exchangeImpl.populateTransaction.initialize();
        const exchangeProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            exchangeImpl.address,
            proxyAdmin.address,
            initTx.data
        );
        const exchange = Exchange.attach(exchangeProxy.address);

        const upgradeEpoch = startEpoch + EPOCH * 10;
        const upgradeTool = await deployMockForName(owner, "IUpgradeTool");
        await upgradeTool.mock.upgradeTimestamp.returns(upgradeEpoch);
        const ExchangeV3 = await ethers.getContractFactory("ExchangeV3");
        const exchangeV3Impl = await ExchangeV3.connect(owner).deploy(
            fund.address,
            chessSchedule.address,
            chessController.address,
            usdc.address,
            6,
            votingEscrow.address,
            MIN_BID_AMOUNT,
            MIN_ASK_AMOUNT,
            0,
            0,
            upgradeTool.address
        );

        // Initialize balance
        await shareM.mock.transferFrom.returns(true);
        await shareA.mock.transferFrom.returns(true);
        await shareB.mock.transferFrom.returns(true);
        await exchange.connect(user1).deposit(TRANCHE_M, USER1_M);
        await exchange.connect(user1).deposit(TRANCHE_A, USER1_A);
        await exchange.connect(user1).deposit(TRANCHE_B, USER1_B);
        await exchange.connect(user2).deposit(TRANCHE_M, USER2_M);
        await exchange.connect(user2).deposit(TRANCHE_A, USER2_A);
        await exchange.connect(user2).deposit(TRANCHE_B, USER2_B);
        await shareM.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await shareA.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await shareB.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await usdc.mint(user1.address, USER1_USDC.div(USDC_TO_ETHER));
        await usdc.mint(user2.address, USER2_USDC.div(USDC_TO_ETHER));
        await usdc.connect(user1).approve(exchange.address, USER1_USDC.div(USDC_TO_ETHER));
        await usdc.connect(user2).approve(exchange.address, USER2_USDC.div(USDC_TO_ETHER));

        await votingEscrow.mock.getLockedBalance
            .withArgs(user1.address)
            .returns([100, startEpoch + WEEK * 10]);
        await votingEscrow.mock.balanceOf.withArgs(user1.address).returns(USER1_VE);
        await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
        await exchange.syncWithVotingEscrow(user1.address);
        await votingEscrow.mock.getLockedBalance
            .withArgs(user2.address)
            .returns([200, startEpoch + WEEK * 20]);
        await votingEscrow.mock.balanceOf.withArgs(user2.address).returns(USER2_VE);
        await exchange.syncWithVotingEscrow(user2.address);

        // Reward rate becomes non-zero now
        await chessSchedule.mock.getRate.withArgs(startEpoch).returns(parseEther("1"));
        await advanceBlockAtTime(startEpoch);

        // Order book of Token M
        // Ask:
        //  0%   4(user1)
        await exchange.connect(user1).placeAsk(TRANCHE_M, 41, ASK_1_PD_0, 0);

        // Order book of Token A and B
        // Ask:
        // +2%   6(user2)
        // +1%   2(user2)  3(user1)  5(user2)
        // Bid:
        //  0%  10(user1)
        for (const tranche of [TRANCHE_A, TRANCHE_B]) {
            await exchange.connect(user2).placeAsk(tranche, 49, ASK_1_PD_2, 0);
            await exchange.connect(user2).placeAsk(tranche, 45, ASK_1_PD_1, 0);
            await exchange.connect(user1).placeAsk(tranche, 45, ASK_2_PD_1, 0);
            await exchange.connect(user2).placeAsk(tranche, 45, ASK_3_PD_1, 0);
            await exchange.connect(user1).placeBid(tranche, 41, BID_1_PD_0, 0);
        }

        return {
            wallets: { user1, user2, owner },
            startEpoch,
            upgradeEpoch,
            fund,
            shareM,
            shareA,
            shareB,
            chessSchedule,
            usdc,
            upgradeTool,
            proxyAdmin,
            exchange: exchange.connect(user1),
            exchangeV3Impl,
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        addr1 = user1.address;
        addr2 = user2.address;
        startEpoch = fixtureData.startEpoch;
        upgradeEpoch = fixtureData.upgradeEpoch;
        fund = fixtureData.fund;
        shareM = fixtureData.shareM;
        shareA = fixtureData.shareA;
        shareB = fixtureData.shareB;
        chessSchedule = fixtureData.chessSchedule;
        usdc = fixtureData.usdc;
        upgradeTool = fixtureData.upgradeTool;
        proxyAdmin = fixtureData.proxyAdmin;
        exchange = fixtureData.exchange;
        exchangeV3Impl = fixtureData.exchangeV3Impl;
    });

    afterEach(async function () {
        expect(await proxyAdmin.getProxyImplementation(exchange.address)).to.equal(
            exchangeV3Impl.address,
            "upgradeToV3() is not called in this test case"
        );
    });

    describe("Balance", function () {
        beforeEach(async function () {
            await upgradeToV3();
        });

        it("totalSupply()", async function () {
            expect(await exchange.totalSupply(TRANCHE_M)).to.equal(TOTAL_M);
            expect(await exchange.totalSupply(TRANCHE_A)).to.equal(TOTAL_A);
            expect(await exchange.totalSupply(TRANCHE_B)).to.equal(TOTAL_B);
        });

        it("availableBalanceOf()", async function () {
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                USER1_M.sub(ASK_1_PD_0)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr1)).to.equal(
                USER1_A.sub(ASK_2_PD_1)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr1)).to.equal(
                USER1_B.sub(ASK_2_PD_1)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr2)).to.equal(USER2_M);
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr2)).to.equal(
                USER2_A.sub(ASK_1_PD_2).sub(ASK_1_PD_1).sub(ASK_3_PD_1)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr2)).to.equal(
                USER2_B.sub(ASK_1_PD_2).sub(ASK_1_PD_1).sub(ASK_3_PD_1)
            );
        });

        it("lockedBalanceOf()", async function () {
            expect(await exchange.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(ASK_1_PD_0);
            expect(await exchange.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(ASK_2_PD_1);
            expect(await exchange.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(ASK_2_PD_1);
            expect(await exchange.lockedBalanceOf(TRANCHE_M, addr2)).to.equal(0);
            expect(await exchange.lockedBalanceOf(TRANCHE_A, addr2)).to.equal(
                ASK_1_PD_2.add(ASK_1_PD_1).add(ASK_3_PD_1)
            );
            expect(await exchange.lockedBalanceOf(TRANCHE_B, addr2)).to.equal(
                ASK_1_PD_2.add(ASK_1_PD_1).add(ASK_3_PD_1)
            );
        });
    });

    describe("Staking reward", function () {
        let rate1: BigNumber;
        let rate2: BigNumber;

        beforeEach(async function () {
            rate1 = parseEther("1").mul(USER1_WORKING_BALANCE).div(WORKING_SUPPLY);
            rate2 = parseEther("1").mul(USER2_WORKING_BALANCE).div(WORKING_SUPPLY);
        });

        it("workingSupply()", async function () {
            await upgradeToV3();
            expect(await exchange.workingSupply()).to.equal(WORKING_SUPPLY);
        });

        it("workingBalanceOf()", async function () {
            await upgradeToV3();
            expect(await exchange.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await exchange.workingBalanceOf(addr2)).to.equal(USER2_WORKING_BALANCE);
        });

        it("Should accumulate rewards after upgrade", async function () {
            await setNextBlockTime(startEpoch + 300);
            await upgradeToV3();
            await advanceBlockAtTime(startEpoch + 1000);
            expect(await exchange.callStatic["claimableRewards"](addr1)).to.be.closeTo(
                rate1.mul(1000),
                1000
            );
            expect(await exchange.callStatic["claimableRewards"](addr2)).to.be.closeTo(
                rate2.mul(1000),
                1000
            );
        });
    });

    describe("Order", function () {
        beforeEach(async function () {
            await upgradeToV3();
        });

        it("getBidOrder()", async function () {
            for (const tranche of [TRANCHE_A, TRANCHE_B]) {
                const order = await exchange.getBidOrder(0, tranche, 41, 1);
                expect(order.maker).to.equal(addr1);
                expect(order.amount).to.equal(BID_1_PD_0);
                expect(order.fillable).to.equal(BID_1_PD_0);
            }
        });

        it("getAskOrder()", async function () {
            for (const tranche of [TRANCHE_A, TRANCHE_B]) {
                const order = await exchange.getAskOrder(0, tranche, 45, 1);
                expect(order.maker).to.equal(addr2);
                expect(order.amount).to.equal(ASK_1_PD_1);
                expect(order.fillable).to.equal(ASK_1_PD_1);
            }
        });

        it("placeBid()", async function () {
            for (const tranche of [TRANCHE_A, TRANCHE_B]) {
                expect((await exchange.bids(0, tranche, 41)).tail).to.equal(1);
                expect((await exchange.getBidOrder(0, tranche, 41, 2)).maker).to.equal(
                    ethers.constants.AddressZero
                );
                await exchange.placeBid(tranche, 41, parseEther("1"), 0);
                expect((await exchange.bids(0, tranche, 41)).tail).to.equal(2);
                expect((await exchange.getBidOrder(0, tranche, 41, 2)).maker).to.equal(addr1);
            }
        });

        it("placeAsk()", async function () {
            for (const tranche of [TRANCHE_A, TRANCHE_B]) {
                expect((await exchange.asks(0, tranche, 45)).tail).to.equal(3);
                expect((await exchange.getAskOrder(0, tranche, 45, 4)).maker).to.equal(
                    ethers.constants.AddressZero
                );
                await exchange.placeAsk(tranche, 45, parseEther("1"), 0);
                expect((await exchange.asks(0, tranche, 45)).tail).to.equal(4);
                expect((await exchange.getAskOrder(0, tranche, 45, 4)).maker).to.equal(addr1);
            }
        });

        it("cancelBid()", async function () {
            for (const tranche of [TRANCHE_A, TRANCHE_B]) {
                expect((await exchange.getBidOrder(0, tranche, 41, 1)).amount).to.gt(0);
                await exchange.cancelBid(0, tranche, 41, 1);
                expect((await exchange.getBidOrder(0, tranche, 41, 1)).amount).to.equal(0);
            }
        });

        it("cancelAsk()", async function () {
            for (const tranche of [TRANCHE_A, TRANCHE_B]) {
                expect((await exchange.getAskOrder(0, tranche, 45, 2)).amount).to.gt(0);
                await exchange.cancelAsk(0, tranche, 45, 2);
                expect((await exchange.getAskOrder(0, tranche, 45, 2)).amount).to.equal(0);
            }
        });
    });

    describe("Trade", function () {
        beforeEach(async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
        });

        it("buyM()", async function () {
            await upgradeToV3();
            await exchange.buyM(0, 60, parseEther("1"));
            const matchedM = parseEther("1").mul(MAKER_RESERVE_M_BPS).div(10000);
            expect((await exchange.getAskOrder(0, TRANCHE_M, 41, 1)).fillable).to.equal(
                ASK_1_PD_0.sub(matchedM)
            );
        });

        it("sellA()", async function () {
            await upgradeToV3();
            await exchange.sellA(0, 20, parseEther("1"));
            const matchedUsdc = parseEther("1").mul(MAKER_RESERVE_A_BPS).div(10000);
            expect((await exchange.getBidOrder(0, TRANCHE_A, 41, 1)).fillable).to.equal(
                BID_1_PD_0.sub(matchedUsdc)
            );
        });

        it("sellB()", async function () {
            await upgradeToV3();
            await exchange.sellB(0, 20, parseEther("1"));
            const matchedUsdc = parseEther("1").mul(MAKER_RESERVE_B_BPS).div(10000);
            expect((await exchange.getBidOrder(0, TRANCHE_B, 41, 1)).fillable).to.equal(
                BID_1_PD_0.sub(matchedUsdc)
            );
        });
    });

    describe("After protocol upgrade", function () {
        beforeEach(async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
        });

        it("Should reject orders and trades", async function () {
            await upgradeToV3();
            await advanceBlockAtTime(upgradeEpoch);
            await expect(exchange.placeBid(TRANCHE_A, 31, parseEther("1"), 0)).to.be.revertedWith(
                "Closed after upgrade"
            );
            await expect(exchange.placeAsk(TRANCHE_B, 51, parseEther("1"), 0)).to.be.revertedWith(
                "Closed after upgrade"
            );
            await expect(exchange.cancelAsk(0, TRANCHE_B, 45, 2)).to.be.revertedWith(
                "Closed after upgrade"
            );
            await expect(exchange.buyA(0, 60, parseEther("1"))).to.be.revertedWith(
                "Closed after upgrade"
            );
            await expect(exchange.sellB(0, 20, parseEther("1"))).to.be.revertedWith(
                "Closed after upgrade"
            );
        });

        it("Should reject deposits", async function () {
            await upgradeToV3();
            await advanceBlockAtTime(upgradeEpoch);
            await expect(exchange.deposit(TRANCHE_M, parseEther("1"))).to.be.revertedWith(
                "Closed after upgrade"
            );
        });

        it("withdraw()", async function () {
            await shareM.mock.transfer.returns(true);
            await shareA.mock.transfer.returns(true);
            await shareB.mock.transfer.returns(true);
            await upgradeToV3();
            await advanceBlockAtTime(upgradeEpoch);

            await exchange.withdraw(TRANCHE_M, 1000);
            await exchange.withdraw(TRANCHE_A, 100);
            await exchange.withdraw(TRANCHE_B, 10);
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                USER1_M.sub(ASK_1_PD_0).sub(1000)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr1)).to.equal(
                USER1_A.sub(ASK_2_PD_1).sub(100)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr1)).to.equal(
                USER1_B.sub(ASK_2_PD_1).sub(10)
            );
        });

        it("settleTaker()", async function () {
            const frozenUsdc = parseEther("0.1");
            await exchange.buyM(0, 60, frozenUsdc);

            await upgradeToV3();
            await advanceBlockAtTime(upgradeEpoch);

            const matchedM = frozenUsdc.mul(MAKER_RESERVE_M_BPS).div(10000);
            const trade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch + EPOCH);
            expect(trade.takerBuy.frozenQuote).to.equal(frozenUsdc);
            expect(trade.takerBuy.reservedBase).to.equal(matchedM);

            const settledM = frozenUsdc;
            const result = await exchange.callStatic.settleTaker(addr1, startEpoch + EPOCH);
            expect(result.amountM).to.equal(settledM);
            expect(result.amountA).to.equal(0);
            expect(result.amountB).to.equal(0);
            expect(result.quoteAmount).to.equal(0);

            const oldM = await exchange.availableBalanceOf(TRANCHE_M, addr1);
            const oldUsdc = await usdc.balanceOf(addr1);
            await exchange.settleTaker(addr1, startEpoch + EPOCH);
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                oldM.add(settledM)
            );
            expect(await usdc.balanceOf(addr1)).to.equal(oldUsdc);
        });

        it("settleMaker()", async function () {
            const frozenUsdc = parseEther("0.1");
            await exchange.buyM(0, 60, frozenUsdc);

            await upgradeToV3();
            await advanceBlockAtTime(upgradeEpoch);

            const matchedM = frozenUsdc.mul(MAKER_RESERVE_M_BPS).div(10000);
            const trade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch + EPOCH);
            expect(trade.makerSell.frozenQuote).to.equal(frozenUsdc);
            expect(trade.makerSell.reservedBase).to.equal(matchedM);

            const settledM = frozenUsdc;
            const result = await exchange.callStatic.settleMaker(addr1, startEpoch + EPOCH);
            expect(result.amountM).to.equal(matchedM.sub(settledM));
            expect(result.amountA).to.equal(0);
            expect(result.amountB).to.equal(0);
            expect(result.quoteAmount).to.equal(frozenUsdc);

            const oldM = await exchange.availableBalanceOf(TRANCHE_M, addr1);
            const oldUsdc = await usdc.balanceOf(addr1);
            await exchange.settleMaker(addr1, startEpoch + EPOCH);
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                oldM.add(matchedM).sub(settledM)
            );
            expect(await usdc.balanceOf(addr1)).to.equal(
                oldUsdc.add(frozenUsdc.div(USDC_TO_ETHER))
            );
        });
    });

    describe("protocolUpgrade()", function () {
        it("Should revert if not called by upgrade tool", async function () {
            await upgradeToV3();
            await expect(exchange.protocolUpgrade(addr1)).to.be.revertedWith("Only upgrade tool");
        });

        it("Should revert before upgrade", async function () {
            await upgradeToV3();
            await expect(upgradeTool.call(exchange, "protocolUpgrade", addr1)).to.be.revertedWith(
                "Not ready for upgrade"
            );
        });

        it("Should succeed without transferring tokens", async function () {
            await upgradeToV3();
            await advanceBlockAtTime(upgradeEpoch);
            await chessSchedule.mock.mint.returns();
            await upgradeTool.call(exchange, "protocolUpgrade", addr1);
        });
    });
});
