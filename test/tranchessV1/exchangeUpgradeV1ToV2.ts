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
} from "../utils";
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
const MAKER_RESERVE_V1_BPS = 11000; // 110%
const MIN_BID_AMOUNT = parseEther("0.8");
const MIN_ASK_AMOUNT = parseEther("0.9");
const MAKER_REQUIREMENT = parseEther("10000");

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

describe("Exchange upgrade V1 to V2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startEpoch: number;
        readonly fund: MockContract;
        readonly shareM: MockContract;
        readonly shareA: MockContract;
        readonly shareB: MockContract;
        readonly chessSchedule: MockContract;
        readonly usdc: Contract;
        readonly votingEscrow: MockContract;
        readonly proxyAdmin: Contract;
        readonly exchange: Contract;
        readonly exchangeV2Impl: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let startEpoch: number;
    let fund: MockContract;
    let shareM: MockContract;
    let shareA: MockContract;
    let shareB: MockContract;
    let chessSchedule: MockContract;
    let usdc: Contract;
    let votingEscrow: MockContract;
    let proxyAdmin: Contract;
    let exchange: Contract;
    let exchangeV2Impl: Contract;

    async function upgradeToV2(): Promise<void> {
        const initTx = await exchangeV2Impl.populateTransaction.initializeV2(owner.address);
        await proxyAdmin.upgradeAndCall(exchange.address, exchangeV2Impl.address, initTx.data);
        exchange = await ethers.getContractAt("ExchangeV2", exchange.address);
    }

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        let startEpoch = (await ethers.provider.getBlock("latest")).timestamp;
        startEpoch = Math.ceil(startEpoch / EPOCH) * EPOCH + EPOCH * 10;
        await advanceBlockAtTime(startEpoch - EPOCH);

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

        const chessController = await deployMockForName(
            owner,
            "contracts/interfaces/IChessController.sol:IChessController"
        );
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");

        const Exchange = await ethers.getContractFactory("Exchange");
        const exchangeImpl = await Exchange.connect(owner).deploy(
            fund.address,
            chessSchedule.address,
            chessController.address,
            usdc.address,
            6,
            votingEscrow.address,
            MIN_BID_AMOUNT,
            MIN_ASK_AMOUNT,
            MAKER_REQUIREMENT,
            0,
            0
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const exchangeProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            exchangeImpl.address,
            proxyAdmin.address,
            "0x"
        );
        const exchange = Exchange.attach(exchangeProxy.address);

        const ExchangeV2 = await ethers.getContractFactory("ExchangeV2");
        const exchangeV2Impl = await ExchangeV2.connect(owner).deploy(
            fund.address,
            chessSchedule.address,
            chessController.address,
            usdc.address,
            6,
            votingEscrow.address,
            MIN_BID_AMOUNT,
            MIN_ASK_AMOUNT,
            MAKER_REQUIREMENT,
            0,
            0
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

        await votingEscrow.mock.getTimestampDropBelow.returns(startEpoch + EPOCH * 500);
        await exchange.connect(user1).applyForMaker();
        await exchange.connect(user2).applyForMaker();

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
            fund,
            shareM,
            shareA,
            shareB,
            chessSchedule,
            usdc,
            votingEscrow,
            proxyAdmin,
            exchange: exchange.connect(user1),
            exchangeV2Impl,
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
        startEpoch = fixtureData.startEpoch;
        fund = fixtureData.fund;
        shareM = fixtureData.shareM;
        shareA = fixtureData.shareA;
        shareB = fixtureData.shareB;
        chessSchedule = fixtureData.chessSchedule;
        usdc = fixtureData.usdc;
        votingEscrow = fixtureData.votingEscrow;
        proxyAdmin = fixtureData.proxyAdmin;
        exchange = fixtureData.exchange;
        exchangeV2Impl = fixtureData.exchangeV2Impl;
    });

    afterEach(async function () {
        expect(await proxyAdmin.getProxyImplementation(exchange.address)).to.equal(
            exchangeV2Impl.address,
            "upgradeToV2() is not called in this test case"
        );
    });

    describe("initializeV2()", function () {
        it("Should revert if not called from proxy admin", async function () {
            await proxyAdmin.upgrade(exchange.address, exchangeV2Impl.address);
            exchange = await ethers.getContractAt("ExchangeV2", exchange.address);
            await expect(exchange.initializeV2(owner.address)).to.be.revertedWith(
                "Only proxy admin"
            );
        });
    });

    describe("Balance", function () {
        beforeEach(async function () {
            await upgradeToV2();
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

        it("withdraw()", async function () {
            await shareM.mock.transfer.returns(true);
            await shareA.mock.transfer.returns(true);
            await shareB.mock.transfer.returns(true);
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
    });

    describe("Staking reward", function () {
        let rewardStartTimestamp: number; // Reward rate becomes non-zero at this timestamp.
        let rate1: BigNumber;
        let rate2: BigNumber;

        beforeEach(async function () {
            rewardStartTimestamp =
                Math.floor(startEpoch / WEEK) * WEEK + WEEK * 10 + SETTLEMENT_TIME;
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp)
                .returns(parseEther("1"));
            await advanceBlockAtTime(rewardStartTimestamp);

            rate1 = parseEther("1").mul(USER1_WEIGHT).div(TOTAL_WEIGHT);
            rate2 = parseEther("1").mul(USER2_WEIGHT).div(TOTAL_WEIGHT);
        });

        it("workingSupply()", async function () {
            await upgradeToV2();
            expect(await exchange.workingSupply()).to.equal(TOTAL_WEIGHT);
        });

        it("workingBalanceOf()", async function () {
            await upgradeToV2();
            expect(await exchange.workingBalanceOf(addr1)).to.equal(USER1_WEIGHT);
            expect(await exchange.workingBalanceOf(addr2)).to.equal(USER2_WEIGHT);
        });

        it("workingSupply() and workingBalanceOf() with boosting", async function () {
            await upgradeToV2();
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([100, rewardStartTimestamp + WEEK * 10]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await exchange.syncWithVotingEscrow(addr1);
            expect(await exchange.workingSupply()).to.equal(
                TOTAL_WEIGHT.sub(USER1_WEIGHT).add(USER1_WORKING_BALANCE)
            );
            expect(await exchange.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);

            await votingEscrow.mock.getLockedBalance
                .withArgs(addr2)
                .returns([200, rewardStartTimestamp + WEEK * 20]);
            await votingEscrow.mock.balanceOf.withArgs(addr2).returns(USER2_VE);
            await exchange.syncWithVotingEscrow(addr2);
            expect(await exchange.workingSupply()).to.equal(WORKING_SUPPLY);
        });

        it("Should accumulate rewards after upgrade", async function () {
            await setNextBlockTime(rewardStartTimestamp + 300);
            await upgradeToV2();
            await advanceBlockAtTime(rewardStartTimestamp + 1000);
            expect(await exchange.callStatic["claimableRewards"](addr1)).to.equal(rate1.mul(1000));
            expect(await exchange.callStatic["claimableRewards"](addr2)).to.equal(rate2.mul(1000));
        });

        it("Should calculate rewards according to boosted working balance", async function () {
            await setNextBlockTime(rewardStartTimestamp + 300);
            await upgradeToV2();

            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([100, rewardStartTimestamp + WEEK * 10]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await setNextBlockTime(rewardStartTimestamp + 1000);
            await exchange.syncWithVotingEscrow(addr1);

            await advanceBlockAtTime(rewardStartTimestamp + 4000);
            const rate1AfterSync = parseEther("1")
                .mul(USER1_WORKING_BALANCE)
                .div(TOTAL_WEIGHT.sub(USER1_WEIGHT).add(USER1_WORKING_BALANCE));
            const reward1 = rate1.mul(1000).add(rate1AfterSync.mul(3000));
            const reward2 = parseEther("1").mul(4000).sub(reward1);
            expect(await exchange.callStatic.claimableRewards(addr1)).to.equal(reward1);
            expect(await exchange.callStatic.claimableRewards(addr2)).to.equal(reward2);
        });
    });

    describe("Order", function () {
        beforeEach(async function () {
            await upgradeToV2();
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
            await upgradeToV2();
            await exchange.buyM(0, 60, parseEther("1"));
            const matchedM = parseEther("1").mul(MAKER_RESERVE_M_BPS).div(10000);
            expect((await exchange.getAskOrder(0, TRANCHE_M, 41, 1)).fillable).to.equal(
                ASK_1_PD_0.sub(matchedM)
            );
        });

        it("sellA()", async function () {
            await upgradeToV2();
            await exchange.sellA(0, 20, parseEther("1"));
            const matchedUsdc = parseEther("1").mul(MAKER_RESERVE_A_BPS).div(10000);
            expect((await exchange.getBidOrder(0, TRANCHE_A, 41, 1)).fillable).to.equal(
                BID_1_PD_0.sub(matchedUsdc)
            );
        });

        it("sellB()", async function () {
            await upgradeToV2();
            await exchange.sellB(0, 20, parseEther("1"));
            const matchedUsdc = parseEther("1").mul(MAKER_RESERVE_B_BPS).div(10000);
            expect((await exchange.getBidOrder(0, TRANCHE_B, 41, 1)).fillable).to.equal(
                BID_1_PD_0.sub(matchedUsdc)
            );
        });

        it("settleTaker()", async function () {
            const frozenUsdc = parseEther("0.1");
            await exchange.buyM(0, 60, frozenUsdc);
            await upgradeToV2();
            const matchedM = frozenUsdc.mul(MAKER_RESERVE_V1_BPS).div(10000);
            const trade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
            expect(trade.takerBuy.frozenQuote).to.equal(frozenUsdc);
            expect(trade.takerBuy.reservedBase).to.equal(matchedM);

            const settledM = frozenUsdc;
            const result = await exchange.callStatic.settleTaker(addr1, startEpoch);
            expect(result.amountM).to.equal(settledM);
            expect(result.amountA).to.equal(0);
            expect(result.amountB).to.equal(0);
            expect(result.quoteAmount).to.equal(0);

            const oldM = await exchange.availableBalanceOf(TRANCHE_M, addr1);
            const oldUsdc = await usdc.balanceOf(addr1);
            await exchange.settleTaker(addr1, startEpoch);
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                oldM.add(settledM)
            );
            expect(await usdc.balanceOf(addr1)).to.equal(oldUsdc);
        });

        it("settleMaker()", async function () {
            const frozenUsdc = parseEther("0.1");
            await exchange.buyM(0, 60, frozenUsdc);
            await upgradeToV2();
            const matchedM = frozenUsdc.mul(MAKER_RESERVE_V1_BPS).div(10000);
            const trade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
            expect(trade.makerSell.frozenQuote).to.equal(frozenUsdc);
            expect(trade.makerSell.reservedBase).to.equal(matchedM);

            const settledM = frozenUsdc;
            const result = await exchange.callStatic.settleMaker(addr1, startEpoch);
            expect(result.amountM).to.equal(matchedM.sub(settledM));
            expect(result.amountA).to.equal(0);
            expect(result.amountB).to.equal(0);
            expect(result.quoteAmount).to.equal(frozenUsdc);

            const oldM = await exchange.availableBalanceOf(TRANCHE_M, addr1);
            const oldUsdc = await usdc.balanceOf(addr1);
            await exchange.settleMaker(addr1, startEpoch);
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                oldM.add(matchedM).sub(settledM)
            );
            expect(await usdc.balanceOf(addr1)).to.equal(
                oldUsdc.add(frozenUsdc.div(USDC_TO_ETHER))
            );
        });
    });
});
