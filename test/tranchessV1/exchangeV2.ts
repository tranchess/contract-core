import { expect } from "chai";
import { BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseUsdc = (value: string) => parseUnits(value, 6);
import { deployMockForName } from "./mock";
import {
    TRANCHE_M,
    TRANCHE_A,
    TRANCHE_B,
    DAY,
    WEEK,
    FixtureWalletMap,
    advanceBlockAtTime,
} from "./utils";

const EPOCH = 1800; // 30 min
const USDC_TO_ETHER = parseUnits("1", 12);
const MAKER_RESERVE_M_BPS = 10500; // 105%
const MAKER_RESERVE_A_BPS = 10010; // 100.1%
const MAKER_RESERVE_B_BPS = 11000; // 110%

const USER1_USDC = parseEther("100000");
const USER1_M = parseEther("10000");
const USER1_A = parseEther("20000");
const USER1_B = parseEther("30000");
const USER2_USDC = parseEther("200000");
const USER2_M = parseEther("20000");
const USER2_A = parseEther("40000");
const USER2_B = parseEther("60000");
const USER3_USDC = parseEther("300000");
const USER3_M = parseEther("30000");
const USER3_A = parseEther("60000");
const USER3_B = parseEther("90000");
const TOTAL_M = USER1_M.add(USER2_M).add(USER3_M);
const TOTAL_A = USER1_A.add(USER2_A).add(USER3_A);
const TOTAL_B = USER1_B.add(USER2_B).add(USER3_B);
const MIN_BID_AMOUNT = parseEther("0.8");
const MIN_ASK_AMOUNT = parseEther("0.9");
const MAKER_REQUIREMENT = parseEther("10000");

describe("ExchangeV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startEpoch: number;
        readonly fund: MockContract;
        readonly shareM: MockContract;
        readonly shareA: MockContract;
        readonly shareB: MockContract;
        readonly twapOracle: MockContract;
        readonly chessSchedule: MockContract;
        readonly chessController: MockContract;
        readonly usdc: Contract;
        readonly votingEscrow: MockContract;
        readonly exchange: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let user3: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let addr3: string;
    let startEpoch: number;
    let fund: MockContract;
    let shareM: MockContract;
    let shareA: MockContract;
    let shareB: MockContract;
    let twapOracle: MockContract;
    let chessSchedule: MockContract;
    let chessController: MockContract;
    let usdc: Contract;
    let votingEscrow: MockContract;
    let exchange: Contract;

    let tranche_list: { tranche: number; share: MockContract }[];

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner] = provider.getWallets();

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
            MAKER_REQUIREMENT,
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
        await exchange.connect(user3).deposit(TRANCHE_M, USER3_M);
        await exchange.connect(user3).deposit(TRANCHE_A, USER3_A);
        await exchange.connect(user3).deposit(TRANCHE_B, USER3_B);
        await shareM.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await shareA.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await shareB.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await usdc.mint(user1.address, USER1_USDC.div(USDC_TO_ETHER));
        await usdc.mint(user2.address, USER2_USDC.div(USDC_TO_ETHER));
        await usdc.mint(user3.address, USER3_USDC.div(USDC_TO_ETHER));
        await usdc.connect(user1).approve(exchange.address, USER1_USDC.div(USDC_TO_ETHER));
        await usdc.connect(user2).approve(exchange.address, USER2_USDC.div(USDC_TO_ETHER));
        await usdc.connect(user3).approve(exchange.address, USER3_USDC.div(USDC_TO_ETHER));

        await votingEscrow.mock.getTimestampDropBelow
            .withArgs(user1.address, MAKER_REQUIREMENT)
            .returns(startEpoch + EPOCH * 500);
        await exchange.connect(user1).applyForMaker();
        await votingEscrow.mock.getTimestampDropBelow
            .withArgs(user2.address, MAKER_REQUIREMENT)
            .returns(startEpoch + EPOCH * 1000);
        await exchange.connect(user2).applyForMaker();

        return {
            wallets: { user1, user2, user3, owner },
            startEpoch,
            fund,
            shareM,
            shareA,
            shareB,
            twapOracle,
            chessSchedule,
            chessController,
            usdc,
            votingEscrow,
            exchange: exchange.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        user3 = fixtureData.wallets.user3;
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        addr2 = user2.address;
        addr3 = user3.address;
        startEpoch = fixtureData.startEpoch;
        fund = fixtureData.fund;
        shareM = fixtureData.shareM;
        shareA = fixtureData.shareA;
        shareB = fixtureData.shareB;
        twapOracle = fixtureData.twapOracle;
        chessSchedule = fixtureData.chessSchedule;
        chessController = fixtureData.chessController;
        usdc = fixtureData.usdc;
        votingEscrow = fixtureData.votingEscrow;
        exchange = fixtureData.exchange;

        tranche_list = [
            { tranche: TRANCHE_M, share: shareM },
            { tranche: TRANCHE_A, share: shareA },
            { tranche: TRANCHE_B, share: shareB },
        ];
    });

    describe("endOfEpoch()", function () {
        it("Should return end of an epoch", async function () {
            expect(await exchange.endOfEpoch(startEpoch - EPOCH)).to.equal(startEpoch);
            expect(await exchange.endOfEpoch(startEpoch - 1)).to.equal(startEpoch);
            expect(await exchange.endOfEpoch(startEpoch)).to.equal(startEpoch + EPOCH);
        });
    });

    describe("placeBid()", function () {
        it("Should check maker expiration", async function () {
            await expect(
                exchange.connect(user3).placeBid(TRANCHE_M, 1, MIN_BID_AMOUNT, 0)
            ).to.be.revertedWith("Only maker");
            await advanceBlockAtTime(startEpoch + EPOCH * 1500);
            await expect(exchange.placeBid(TRANCHE_M, 1, MIN_BID_AMOUNT, 0)).to.be.revertedWith(
                "Only maker"
            );
        });

        it("Should check min amount", async function () {
            await expect(
                exchange.placeBid(TRANCHE_M, 1, MIN_BID_AMOUNT.sub(1), 0)
            ).to.be.revertedWith("Quote amount too low");
        });

        it("Should check pd level", async function () {
            await expect(exchange.placeBid(TRANCHE_M, 0, MIN_BID_AMOUNT, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.placeBid(TRANCHE_M, 82, MIN_BID_AMOUNT, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );

            await exchange.placeAsk(TRANCHE_M, 41, parseEther("1"), 0);
            await expect(exchange.placeBid(TRANCHE_M, 41, MIN_BID_AMOUNT, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should check version", async function () {
            await expect(exchange.placeBid(TRANCHE_M, 1, MIN_BID_AMOUNT, 1)).to.be.revertedWith(
                "Invalid version"
            );
        });

        it("Should transfer USDC", async function () {
            for (const { tranche } of tranche_list) {
                await expect(() =>
                    exchange.placeBid(tranche, 1, parseEther("100"), 0)
                ).to.changeTokenBalances(
                    usdc,
                    [user1, exchange],
                    [parseUsdc("-100"), parseUsdc("100")]
                );
            }
        });

        it("Should update best bid premium-discount level", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeBid(tranche, 41, parseEther("100"), 0);
                expect(await exchange.bestBids(0, tranche)).to.equal(41);
                await exchange.placeBid(tranche, 61, parseEther("100"), 0);
                expect(await exchange.bestBids(0, tranche)).to.equal(61);
                await exchange.placeBid(tranche, 51, parseEther("100"), 0);
                expect(await exchange.bestBids(0, tranche)).to.equal(61);
            }
        });

        it("Should append order to order queue", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeBid(tranche, 41, parseEther("100"), 0);
                const order1 = await exchange.getBidOrder(0, tranche, 41, 1);
                expect(order1.maker).to.equal(addr1);
                expect(order1.amount).to.equal(parseEther("100"));
                expect(order1.fillable).to.equal(parseEther("100"));

                await exchange.connect(user2).placeBid(tranche, 41, parseEther("200"), 0);
                const order2 = await exchange.getBidOrder(0, tranche, 41, 2);
                expect(order2.maker).to.equal(addr2);
                expect(order2.amount).to.equal(parseEther("200"));
                expect(order2.fillable).to.equal(parseEther("200"));
            }
        });

        it("Should emit event", async function () {
            await expect(exchange.placeBid(TRANCHE_A, 41, parseEther("1"), 0))
                .to.emit(exchange, "BidOrderPlaced")
                .withArgs(addr1, TRANCHE_A, 41, parseEther("1"), 0, 1);
        });
    });

    describe("placeAsk()", function () {
        it("Should check maker expiration", async function () {
            await expect(
                exchange.connect(user3).placeAsk(TRANCHE_M, 81, MIN_ASK_AMOUNT, 0)
            ).to.be.revertedWith("Only maker");
            await advanceBlockAtTime(startEpoch + EPOCH * 1000);
            await expect(exchange.placeAsk(TRANCHE_M, 81, MIN_ASK_AMOUNT, 0)).to.be.revertedWith(
                "Only maker"
            );
        });

        it("Should check min amount", async function () {
            await expect(
                exchange.placeAsk(TRANCHE_M, 81, MIN_ASK_AMOUNT.sub(1), 0)
            ).to.be.revertedWith("Base amount too low");
        });

        it("Should check pd level", async function () {
            await expect(exchange.placeAsk(TRANCHE_M, 0, MIN_ASK_AMOUNT, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.placeAsk(TRANCHE_M, 82, MIN_ASK_AMOUNT, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );

            await exchange.placeBid(TRANCHE_M, 41, parseEther("100"), 0);
            await expect(exchange.placeAsk(TRANCHE_M, 41, MIN_ASK_AMOUNT, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should check version", async function () {
            await expect(exchange.placeAsk(TRANCHE_M, 81, MIN_ASK_AMOUNT, 1)).to.be.revertedWith(
                "Invalid version"
            );
        });

        it("Should lock share tokens", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeAsk(tranche, 81, parseEther("100"), 0);
                expect(await exchange.lockedBalanceOf(tranche, addr1)).to.equal(parseEther("100"));
            }
        });

        it("Should revert if balance is not enough", async function () {
            await expect(exchange.placeAsk(TRANCHE_M, 81, USER1_M.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to lock"
            );
            await expect(exchange.placeAsk(TRANCHE_A, 81, USER1_A.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to lock"
            );
            await expect(exchange.placeAsk(TRANCHE_B, 81, USER1_B.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to lock"
            );
        });

        it("Should update best ask premium-discount level", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeAsk(tranche, 41, parseEther("1"), 0);
                expect(await exchange.bestAsks(0, tranche)).to.equal(41);
                await exchange.placeAsk(tranche, 21, parseEther("1"), 0);
                expect(await exchange.bestAsks(0, tranche)).to.equal(21);
                await exchange.placeAsk(tranche, 31, parseEther("1"), 0);
                expect(await exchange.bestAsks(0, tranche)).to.equal(21);
            }
        });

        it("Should append order to order queue", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeAsk(tranche, 41, parseEther("1"), 0);
                const order1 = await exchange.getAskOrder(0, tranche, 41, 1);
                expect(order1.maker).to.equal(addr1);
                expect(order1.amount).to.equal(parseEther("1"));
                expect(order1.fillable).to.equal(parseEther("1"));

                await exchange.connect(user2).placeAsk(tranche, 41, parseEther("2"), 0);
                const order2 = await exchange.getAskOrder(0, tranche, 41, 2);
                expect(order2.maker).to.equal(addr2);
                expect(order2.amount).to.equal(parseEther("2"));
                expect(order2.fillable).to.equal(parseEther("2"));
            }
        });

        it("Should emit event", async function () {
            await expect(exchange.placeAsk(TRANCHE_A, 41, parseEther("1"), 0))
                .to.emit(exchange, "AskOrderPlaced")
                .withArgs(addr1, TRANCHE_A, 41, parseEther("1"), 0, 1);
        });
    });

    // Constants in orderBookFixture
    const ASK_1_PD_2 = parseEther("60");
    const ASK_1_PD_1 = parseEther("20");
    const ASK_2_PD_1 = parseEther("30");
    const ASK_3_PD_1 = parseEther("50");
    const ASK_1_PD_0 = parseEther("100");
    const BID_1_PD_0 = parseEther("100");
    const BID_1_PD_N1 = parseEther("50");
    const BID_2_PD_N1 = parseEther("20");
    const BID_3_PD_N1 = parseEther("30");
    const BID_1_PD_N2 = parseEther("80");

    async function askOrderBookFixture(): Promise<FixtureData> {
        const f = await loadFixture(deployFixture);
        const u2 = f.wallets.user2;
        const u3 = f.wallets.user3;
        await f.votingEscrow.mock.getTimestampDropBelow
            .withArgs(u3.address, MAKER_REQUIREMENT)
            .returns(f.startEpoch + EPOCH * 1000);
        await f.exchange.connect(u3).applyForMaker();

        // Order book of Token M
        // Ask:
        // +2%   60(user3)
        // +1%   20(user2)  30(user3)  50(user2)
        //  0%  100(user2)
        await f.exchange.connect(u3).placeAsk(TRANCHE_M, 49, ASK_1_PD_2, 0);
        await f.exchange.connect(u2).placeAsk(TRANCHE_M, 45, ASK_1_PD_1, 0);
        await f.exchange.connect(u3).placeAsk(TRANCHE_M, 45, ASK_2_PD_1, 0);
        await f.exchange.connect(u2).placeAsk(TRANCHE_M, 45, ASK_3_PD_1, 0);
        await f.exchange.connect(u2).placeAsk(TRANCHE_M, 41, ASK_1_PD_0, 0);

        return f;
    }

    async function bidOrderBookFixture(): Promise<FixtureData> {
        const f = await loadFixture(deployFixture);
        const u2 = f.wallets.user2;
        const u3 = f.wallets.user3;
        await f.votingEscrow.mock.getTimestampDropBelow
            .withArgs(u3.address, MAKER_REQUIREMENT)
            .returns(f.startEpoch + EPOCH * 1000);
        await f.exchange.connect(u3).applyForMaker();
        await f.votingEscrow.mock.getTimestampDropBelow.revertsWithReason(
            "Mock on the method is not initialized"
        );

        // Order book of Token M
        // Bid:
        //  0%  100(user2)
        // -1%   50(user3)  20(user2)  30(user2)
        // -2%   80(user3)
        await f.exchange.connect(u2).placeBid(TRANCHE_M, 41, BID_1_PD_0, 0);
        await f.exchange.connect(u3).placeBid(TRANCHE_M, 37, BID_1_PD_N1, 0);
        await f.exchange.connect(u2).placeBid(TRANCHE_M, 37, BID_2_PD_N1, 0);
        await f.exchange.connect(u2).placeBid(TRANCHE_M, 37, BID_3_PD_N1, 0);
        await f.exchange.connect(u3).placeBid(TRANCHE_M, 33, BID_1_PD_N2, 0);

        return f;
    }

    describe("buyM()", function () {
        let outerFixture: Fixture<FixtureData>;

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = askOrderBookFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should revert if exchange is inactive", async function () {
            await fund.mock.isExchangeActive.returns(false);
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.buyM(0, 41, 1)).to.be.revertedWith("Exchange is inactive");
        });

        it("Should revert if price is not available", async function () {
            await twapOracle.mock.getTwap.returns(0);
            await expect(exchange.buyM(0, 41, 1)).to.be.revertedWith("Price is not available");
        });

        it("Should revert if estimated NAV is zero", async function () {
            await fund.mock.extrapolateNav.returns(0, 0, 0);
            await expect(exchange.buyM(0, 41, 1)).to.be.revertedWith("Zero estimated NAV");
        });

        it("Should check pd level", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.buyM(0, 0, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.buyM(0, 82, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should check version", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.buyM(1, 41, 1)).to.be.revertedWith("Invalid version");
        });

        it("Should revert if no order can be matched", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.buyM(0, 40, 1)).to.be.revertedWith(
                "Nothing can be bought at the given premium-discount level"
            );
        });

        // Buy shares that can be completely filled by the best maker order.
        // USDC amount in the taker order literally equals to half of the amount of shares
        // in the best maker order.
        describe("Taker is completely filled with a single maker order", function () {
            const estimatedNav = parseEther("1.1");
            const matchedUsdc = ASK_1_PD_0.div(2);
            const transferedUsdc = matchedUsdc.add(USDC_TO_ETHER).sub(1).div(USDC_TO_ETHER);
            const matchedShares = matchedUsdc
                .mul(MAKER_RESERVE_M_BPS)
                .div(10000)
                .mul(parseEther("1"))
                .div(estimatedNav);
            const buyTxBuilder = () => exchange.buyM(0, 49, matchedUsdc);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(estimatedNav, 0, 0);
            });

            it("Should update balance", async function () {
                await expect(buyTxBuilder).to.changeTokenBalances(
                    usdc,
                    [user1, exchange],
                    [transferedUsdc.mul(-1), transferedUsdc]
                );
            });

            it("Should update the maker order", async function () {
                await buyTxBuilder();
                const order = await exchange.getAskOrder(0, TRANCHE_M, 41, 1);
                expect(order.fillable).to.equal(ASK_1_PD_0.sub(matchedShares));
            });

            it("Should update unsettled trade", async function () {
                await buyTxBuilder();
                const takerTrade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
                expect(takerTrade.takerBuy.frozenQuote).to.equal(matchedUsdc);
                expect(takerTrade.takerBuy.reservedBase).to.equal(matchedShares);
                const makerTrade = await exchange.unsettledTrades(addr2, TRANCHE_M, startEpoch);
                expect(makerTrade.makerSell.frozenQuote).to.equal(matchedUsdc);
                expect(makerTrade.makerSell.reservedBase).to.equal(matchedShares);
            });

            it("Should emit event", async function () {
                await expect(buyTxBuilder())
                    .to.emit(exchange, "BuyTrade")
                    .withArgs(addr1, TRANCHE_M, matchedUsdc, 0, 41, 1, matchedShares);
            });

            it("Should keep the best ask level unchanged", async function () {
                await buyTxBuilder();
                expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(41);
            });
        });

        // USDC amount in the taker order literally equals to the amount of shares
        // in the best maker order. Estimated NAV is 0.9 and the maker order is completely filled.
        describe("A single maker is completely filled and the taker is partially filled", function () {
            const estimatedNav = parseEther("0.9");
            const matchedUsdc = ASK_1_PD_0.mul(estimatedNav)
                .div(parseEther("1"))
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const transferedUsdc = matchedUsdc.add(USDC_TO_ETHER).sub(1).div(USDC_TO_ETHER);
            const matchedShares = ASK_1_PD_0;
            const buyTxBuilder = () => exchange.buyM(0, 42, ASK_1_PD_0);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(estimatedNav, 0, 0);
            });

            it("Should update balance", async function () {
                await expect(buyTxBuilder).to.changeTokenBalances(
                    usdc,
                    [user1, exchange],
                    [transferedUsdc.mul(-1), transferedUsdc]
                );
            });

            it("Should delete the maker order", async function () {
                await buyTxBuilder();
                const queue = await exchange.asks(0, TRANCHE_M, 41);
                expect(queue.head).to.equal(0);
                expect(queue.tail).to.equal(0);
                const order = await exchange.getAskOrder(0, TRANCHE_M, 41, 1);
                expect(order.maker).to.equal(ethers.constants.AddressZero);
                expect(order.amount).to.equal(0);
                expect(order.fillable).to.equal(0);
            });

            it("Should update unsettled trade", async function () {
                await buyTxBuilder();
                const takerTrade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
                expect(takerTrade.takerBuy.frozenQuote).to.equal(matchedUsdc);
                expect(takerTrade.takerBuy.reservedBase).to.equal(matchedShares);
                const makerTrade = await exchange.unsettledTrades(addr2, TRANCHE_M, startEpoch);
                expect(makerTrade.makerSell.frozenQuote).to.equal(matchedUsdc);
                expect(makerTrade.makerSell.reservedBase).to.equal(matchedShares);
            });

            it("Should emit event", async function () {
                await expect(buyTxBuilder())
                    .to.emit(exchange, "BuyTrade")
                    .withArgs(addr1, TRANCHE_M, matchedUsdc, 0, 43, 0, 0);
            });

            it("Should update the best ask level", async function () {
                await buyTxBuilder();
                expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(45);
            });
        });

        // Buy shares with 200 USDC at premium 2%. Estimated NAV is 1.
        // All orders at 0% and 1% are filled. The order at 2% is partially filled.
        describe("Fill orders at multiple premium-discount level", function () {
            const matchedUsdc = parseEther("200");
            const transferedUsdc = parseUsdc("200");
            const matchedUsdcAt0 = ASK_1_PD_0.mul(10000).div(MAKER_RESERVE_M_BPS);
            const matchedUsdcOrder1At1 = ASK_1_PD_1.mul(101)
                .div(100)
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const matchedUsdcOrder2At1 = ASK_2_PD_1.mul(101)
                .div(100)
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const matchedUsdcOrder3At1 = ASK_3_PD_1.mul(101)
                .div(100)
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const matchedUsdcAt1 = matchedUsdcOrder1At1
                .add(matchedUsdcOrder2At1)
                .add(matchedUsdcOrder3At1);
            const matchedUsdcAt2 = matchedUsdc.sub(matchedUsdcAt0).sub(matchedUsdcAt1);
            const matchedSharesAt2 = matchedUsdcAt2
                .mul(MAKER_RESERVE_M_BPS)
                .div(10000)
                .mul(100)
                .div(102);
            const buyTxBuilder = () => exchange.buyM(0, 49, matchedUsdc);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(parseEther("1"), 0, 0);
            });

            it("Should update balance", async function () {
                await expect(buyTxBuilder).to.changeTokenBalances(
                    usdc,
                    [user1, exchange],
                    [transferedUsdc.mul(-1), transferedUsdc]
                );
            });

            it("Should update maker orders", async function () {
                await buyTxBuilder();
                const queueAt0 = await exchange.asks(0, TRANCHE_M, 41);
                expect(queueAt0.head).to.equal(0);
                expect(queueAt0.tail).to.equal(0);
                const queueAt1 = await exchange.asks(0, TRANCHE_M, 45);
                expect(queueAt1.head).to.equal(0);
                expect(queueAt1.tail).to.equal(0);
                const queueAt2 = await exchange.asks(0, TRANCHE_M, 49);
                expect(queueAt2.head).to.equal(1);
                expect(queueAt2.tail).to.equal(1);
                const order = await exchange.getAskOrder(0, TRANCHE_M, 49, 1);
                expect(order.fillable).to.equal(ASK_1_PD_2.sub(matchedSharesAt2));
            });

            it("Should update unsettled trade", async function () {
                await buyTxBuilder();
                const takerTrade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
                expect(takerTrade.takerBuy.frozenQuote).to.equal(matchedUsdc);
                expect(takerTrade.takerBuy.reservedBase).to.equal(
                    ASK_1_PD_0.add(ASK_1_PD_1).add(ASK_2_PD_1).add(ASK_3_PD_1).add(matchedSharesAt2)
                );
                const maker2Trade = await exchange.unsettledTrades(addr2, TRANCHE_M, startEpoch);
                expect(maker2Trade.makerSell.frozenQuote).to.equal(
                    matchedUsdcAt0.add(matchedUsdcOrder1At1).add(matchedUsdcOrder3At1)
                );
                expect(maker2Trade.makerSell.reservedBase).to.equal(
                    ASK_1_PD_0.add(ASK_1_PD_1).add(ASK_3_PD_1)
                );
                const maker3Trade = await exchange.unsettledTrades(addr3, TRANCHE_M, startEpoch);
                expect(maker3Trade.makerSell.frozenQuote).to.equal(
                    matchedUsdcOrder2At1.add(matchedUsdcAt2)
                );
                expect(maker3Trade.makerSell.reservedBase).to.equal(
                    ASK_2_PD_1.add(matchedSharesAt2)
                );
            });

            it("Should emit event", async function () {
                await expect(buyTxBuilder())
                    .to.emit(exchange, "BuyTrade")
                    .withArgs(addr1, TRANCHE_M, matchedUsdc, 0, 49, 1, matchedSharesAt2);
            });

            it("Should update the best ask level", async function () {
                await buyTxBuilder();
                expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(49);
            });
        });
    });

    describe("cancelAsk()", function () {
        let outerFixture: Fixture<FixtureData>;

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = askOrderBookFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should revert when canceling non-existent order", async function () {
            await expect(
                exchange.connect(user2).cancelAsk(0, TRANCHE_M, 41, 99)
            ).to.be.revertedWith("Maker address mismatched");
            await expect(
                exchange.connect(user2).cancelAsk(99, TRANCHE_M, 41, 1)
            ).to.be.revertedWith("Maker address mismatched");
        });

        it("Should revert when canceling other's order", async function () {
            await expect(exchange.cancelAsk(0, TRANCHE_M, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should revert when canceling completely filled order", async function () {
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.buyM(0, 42, ASK_1_PD_0);
            await expect(exchange.connect(user2).cancelAsk(0, TRANCHE_M, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should delete the canceled order", async function () {
            await exchange.connect(user2).cancelAsk(0, TRANCHE_M, 41, 1);
            const order = await exchange.getAskOrder(0, TRANCHE_M, 41, 1);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.fillable).to.equal(0);
        });

        it("Should update balance", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.buyM(0, 42, ASK_1_PD_0.div(2));
            const matchedShares = ASK_1_PD_0.div(2).mul(MAKER_RESERVE_M_BPS).div(10000);

            const oldAvailable = await exchange.availableBalanceOf(TRANCHE_M, addr2);
            await exchange.connect(user2).cancelAsk(0, TRANCHE_M, 41, 1);
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr2)).to.equal(
                oldAvailable.add(ASK_1_PD_0).sub(matchedShares)
            );
        });

        it("Should emit event", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.buyM(0, 42, ASK_1_PD_0.div(2));
            const matchedUsdc = ASK_1_PD_0.div(2).mul(MAKER_RESERVE_M_BPS).div(10000);

            await expect(exchange.connect(user2).cancelAsk(0, TRANCHE_M, 41, 1))
                .to.emit(exchange, "AskOrderCanceled")
                .withArgs(addr2, TRANCHE_M, 41, ASK_1_PD_0, 0, 1, ASK_1_PD_0.sub(matchedUsdc));
        });

        it("Should update best ask", async function () {
            await exchange.connect(user2).cancelAsk(0, TRANCHE_M, 45, 1);
            expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(41);

            await exchange.connect(user2).cancelAsk(0, TRANCHE_M, 41, 1);
            expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(45);

            await exchange.connect(user3).cancelAsk(0, TRANCHE_M, 45, 2);
            expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(45);

            await exchange.connect(user2).cancelAsk(0, TRANCHE_M, 45, 3);
            expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(49);

            await exchange.connect(user3).cancelAsk(0, TRANCHE_M, 49, 1);
            expect(await exchange.bestAsks(0, TRANCHE_M)).to.equal(82);
        });
    });

    describe("sellM()", function () {
        let outerFixture: Fixture<FixtureData>;

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = bidOrderBookFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should revert if exchange is inactive", async function () {
            await fund.mock.isExchangeActive.returns(false);
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.sellM(0, 41, 1)).to.be.revertedWith("Exchange is inactive");
        });

        it("Should revert if price is not available", async function () {
            await twapOracle.mock.getTwap.returns(0);
            await expect(exchange.sellM(0, 41, 1)).to.be.revertedWith("Price is not available");
        });

        it("Should revert if estimated NAV is zero", async function () {
            await fund.mock.extrapolateNav.returns(0, 0, 0);
            await expect(exchange.sellM(0, 41, 1)).to.be.revertedWith("Zero estimated NAV");
        });

        it("Should check pd level", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.sellM(0, 0, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.sellM(0, 82, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should check version", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.sellM(1, 41, 1)).to.be.revertedWith("Invalid version");
        });

        it("Should revert if no order can be matched", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.sellM(0, 42, 1)).to.be.revertedWith(
                "Nothing can be sold at the given premium-discount level"
            );
        });

        // Sell shares that can be completely filled by the best maker order.
        // Share amount in the taker order literally equals to half of the amount of USDC
        // in the best maker order.
        describe("Taker is completely filled with a single maker order", function () {
            const estimatedNav = parseEther("0.9");
            const matchedShares = BID_1_PD_0.div(2);
            const matchedUsdc = matchedShares
                .mul(MAKER_RESERVE_M_BPS)
                .div(10000)
                .mul(estimatedNav)
                .div(parseEther("1"));
            const sellTxBuilder = () => exchange.sellM(0, 33, matchedShares);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(estimatedNav, 0, 0);
            });

            it("Should update balance", async function () {
                await sellTxBuilder();
                expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                    USER1_M.sub(matchedShares)
                );
            });

            it("Should update the maker order", async function () {
                await sellTxBuilder();
                const order = await exchange.getBidOrder(0, TRANCHE_M, 41, 1);
                expect(order.fillable).to.equal(BID_1_PD_0.sub(matchedUsdc));
            });

            it("Should update unsettled trade", async function () {
                await sellTxBuilder();
                const takerTrade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
                expect(takerTrade.takerSell.frozenBase).to.equal(matchedShares);
                expect(takerTrade.takerSell.reservedQuote).to.equal(matchedUsdc);
                const makerTrade = await exchange.unsettledTrades(addr2, TRANCHE_M, startEpoch);
                expect(makerTrade.makerBuy.frozenBase).to.equal(matchedShares);
                expect(makerTrade.makerBuy.reservedQuote).to.equal(matchedUsdc);
            });

            it("Should emit event", async function () {
                await expect(sellTxBuilder())
                    .to.emit(exchange, "SellTrade")
                    .withArgs(addr1, TRANCHE_M, matchedShares, 0, 41, 1, matchedUsdc);
            });

            it("Should keep the best bid level unchanged", async function () {
                await sellTxBuilder();
                expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(41);
            });
        });

        // Share amount in the taker order literally equals to the amount of USDC
        // in the best maker order. Estimated NAV is 1.1 and the maker order is completely filled.
        describe("A single maker is completely filled and the taker is partially filled", function () {
            const estimatedNav = parseEther("1.1");
            const matchedShares = BID_1_PD_0.mul(parseEther("1"))
                .div(estimatedNav)
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const matchedUsdc = BID_1_PD_0;
            const sellTxBuilder = () => exchange.sellM(0, 40, BID_1_PD_0);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(estimatedNav, 0, 0);
            });

            it("Should update balance", async function () {
                await sellTxBuilder();
                expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                    USER1_M.sub(matchedShares)
                );
            });

            it("Should delete the maker order", async function () {
                await sellTxBuilder();
                const queue = await exchange.bids(0, TRANCHE_M, 41);
                expect(queue.head).to.equal(0);
                expect(queue.tail).to.equal(0);
                const order = await exchange.getBidOrder(0, TRANCHE_M, 41, 1);
                expect(order.maker).to.equal(ethers.constants.AddressZero);
                expect(order.amount).to.equal(0);
                expect(order.fillable).to.equal(0);
            });

            it("Should update unsettled trade", async function () {
                await sellTxBuilder();
                const takerTrade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
                expect(takerTrade.takerSell.frozenBase).to.equal(matchedShares);
                expect(takerTrade.takerSell.reservedQuote).to.equal(matchedUsdc);
                const makerTrade = await exchange.unsettledTrades(addr2, TRANCHE_M, startEpoch);
                expect(makerTrade.makerBuy.frozenBase).to.equal(matchedShares);
                expect(makerTrade.makerBuy.reservedQuote).to.equal(matchedUsdc);
            });

            it("Should emit event", async function () {
                await expect(sellTxBuilder())
                    .to.emit(exchange, "SellTrade")
                    .withArgs(addr1, TRANCHE_M, matchedShares, 0, 39, 0, 0);
            });

            it("Should update the best bid level", async function () {
                await sellTxBuilder();
                expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(37);
            });
        });

        // Sell 200 shares at discount -2%. Estimated NAV is 1.
        // All orders at 0% and -1% are filled. The order at -2% is partially filled.
        describe("Fill orders at multiple premium-discount level", function () {
            const matchedShares = parseEther("200");
            const matchedSharesAt0 = BID_1_PD_0.mul(10000).div(MAKER_RESERVE_M_BPS);
            const matchedSharesOrder1AtN1 = BID_1_PD_N1.mul(100)
                .div(99)
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const matchedSharesOrder2AtN1 = BID_2_PD_N1.mul(100)
                .div(99)
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const matchedSharesOrder3AtN1 = BID_3_PD_N1.mul(100)
                .div(99)
                .mul(10000)
                .div(MAKER_RESERVE_M_BPS);
            const matchedSharesAtN1 = matchedSharesOrder1AtN1
                .add(matchedSharesOrder2AtN1)
                .add(matchedSharesOrder3AtN1);
            const matchedSharesAtN2 = matchedShares.sub(matchedSharesAt0).sub(matchedSharesAtN1);
            const matchedUsdcAtN2 = matchedSharesAtN2
                .mul(MAKER_RESERVE_M_BPS)
                .div(10000)
                .mul(98)
                .div(100);
            const sellTxBuilder = () => exchange.sellM(0, 33, matchedShares);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(parseEther("1"), 0, 0);
            });

            it("Should update balance", async function () {
                await sellTxBuilder();
                expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(
                    USER1_M.sub(matchedShares)
                );
            });

            it("Should update maker orders", async function () {
                await sellTxBuilder();
                const queueAt0 = await exchange.bids(0, TRANCHE_M, 41);
                expect(queueAt0.head).to.equal(0);
                expect(queueAt0.tail).to.equal(0);
                const queueAt1 = await exchange.bids(0, TRANCHE_M, 37);
                expect(queueAt1.head).to.equal(0);
                expect(queueAt1.tail).to.equal(0);
                const queueAt2 = await exchange.bids(0, TRANCHE_M, 33);
                expect(queueAt2.head).to.equal(1);
                expect(queueAt2.tail).to.equal(1);
                const order = await exchange.getBidOrder(0, TRANCHE_M, 33, 1);
                expect(order.fillable).to.equal(BID_1_PD_N2.sub(matchedUsdcAtN2));
            });

            it("Should update unsettled trade", async function () {
                await sellTxBuilder();
                const takerTrade = await exchange.unsettledTrades(addr1, TRANCHE_M, startEpoch);
                expect(takerTrade.takerSell.frozenBase).to.equal(matchedShares);
                expect(takerTrade.takerSell.reservedQuote).to.equal(
                    BID_1_PD_0.add(BID_1_PD_N1)
                        .add(BID_2_PD_N1)
                        .add(BID_3_PD_N1)
                        .add(matchedUsdcAtN2)
                );
                const maker2Trade = await exchange.unsettledTrades(addr2, TRANCHE_M, startEpoch);
                expect(maker2Trade.makerBuy.frozenBase).to.equal(
                    matchedSharesAt0.add(matchedSharesOrder2AtN1).add(matchedSharesOrder3AtN1)
                );
                expect(maker2Trade.makerBuy.reservedQuote).to.equal(
                    BID_1_PD_0.add(BID_2_PD_N1).add(BID_3_PD_N1)
                );
                const maker3Trade = await exchange.unsettledTrades(addr3, TRANCHE_M, startEpoch);
                expect(maker3Trade.makerBuy.frozenBase).to.equal(
                    matchedSharesOrder1AtN1.add(matchedSharesAtN2)
                );
                expect(maker3Trade.makerBuy.reservedQuote).to.equal(
                    BID_1_PD_N1.add(matchedUsdcAtN2)
                );
            });

            it("Should emit event", async function () {
                await expect(sellTxBuilder())
                    .to.emit(exchange, "SellTrade")
                    .withArgs(addr1, TRANCHE_M, matchedShares, 0, 33, 1, matchedUsdcAtN2);
            });

            it("Should update the best bid level", async function () {
                await sellTxBuilder();
                expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(33);
            });
        });
    });

    describe("cancelBid()", function () {
        let outerFixture: Fixture<FixtureData>;

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = bidOrderBookFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should revert when canceling non-existent order", async function () {
            await expect(
                exchange.connect(user2).cancelBid(0, TRANCHE_M, 41, 99)
            ).to.be.revertedWith("Maker address mismatched");
            await expect(
                exchange.connect(user2).cancelBid(99, TRANCHE_M, 41, 1)
            ).to.be.revertedWith("Maker address mismatched");
        });

        it("Should revert when canceling other's order", async function () {
            await expect(exchange.cancelBid(0, TRANCHE_M, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should revert when canceling completely filled order", async function () {
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.sellM(0, 40, BID_1_PD_0);
            await expect(exchange.connect(user2).cancelBid(0, TRANCHE_M, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should delete the canceled order", async function () {
            await exchange.connect(user2).cancelBid(0, TRANCHE_M, 41, 1);
            const order = await exchange.getBidOrder(0, TRANCHE_M, 41, 1);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.fillable).to.equal(0);
        });

        it("Should update balance", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.sellM(0, 40, BID_1_PD_0.div(2));
            const matchedUsdc = BID_1_PD_0.div(2).mul(MAKER_RESERVE_M_BPS).div(10000);

            const returnedUsdc = BID_1_PD_0.sub(matchedUsdc).div(USDC_TO_ETHER);
            await expect(() =>
                exchange.connect(user2).cancelBid(0, TRANCHE_M, 41, 1)
            ).to.changeTokenBalances(usdc, [user2, exchange], [returnedUsdc, returnedUsdc.mul(-1)]);
        });

        it("Should emit event", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.sellM(0, 40, BID_1_PD_0.div(2));
            const matchedUsdc = BID_1_PD_0.div(2).mul(MAKER_RESERVE_M_BPS).div(10000);

            await expect(exchange.connect(user2).cancelBid(0, TRANCHE_M, 41, 1))
                .to.emit(exchange, "BidOrderCanceled")
                .withArgs(addr2, TRANCHE_M, 41, BID_1_PD_0, 0, 1, BID_1_PD_0.sub(matchedUsdc));
        });

        it("Should update best bid", async function () {
            await exchange.connect(user2).cancelBid(0, TRANCHE_M, 37, 2);
            expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(41);

            await exchange.connect(user2).cancelBid(0, TRANCHE_M, 41, 1);
            expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(37);

            await exchange.connect(user3).cancelBid(0, TRANCHE_M, 37, 1);
            expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(37);

            await exchange.connect(user2).cancelBid(0, TRANCHE_M, 37, 3);
            expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(33);

            await exchange.connect(user3).cancelBid(0, TRANCHE_M, 33, 1);
            expect(await exchange.bestBids(0, TRANCHE_M)).to.equal(0);
        });
    });

    describe("settleMaker() and settleTaker()", function () {
        let outerFixture: Fixture<FixtureData>;
        const frozenUsdcForM = parseEther("1");
        const effectiveUsdcForM = frozenUsdcForM.mul(100).div(105);
        const reservedM = frozenUsdcForM.mul(MAKER_RESERVE_M_BPS).div(10000).mul(100).div(105);
        const frozenUsdcForA = parseEther("2");
        const effectiveUsdcForA = frozenUsdcForA.mul(100).div(105);
        const reservedA = frozenUsdcForA.mul(MAKER_RESERVE_A_BPS).div(10000).mul(100).div(105);
        const frozenB = parseEther("3");
        const effectiveB = frozenB.mul(95).div(100);
        const reservedUsdcForB = frozenB.mul(MAKER_RESERVE_B_BPS).div(10000).mul(95).div(100);

        async function tradeFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            const u2 = f.wallets.user2;

            // Order book of all the three tranches
            // Ask:
            // +10%   20(user2)
            // Bid:
            // -10%   50(user2)
            await f.exchange.connect(u2).placeAsk(TRANCHE_M, 61, ASK_1_PD_1, 0);
            await f.exchange.connect(u2).placeAsk(TRANCHE_A, 61, ASK_1_PD_1, 0);
            await f.exchange.connect(u2).placeAsk(TRANCHE_B, 61, ASK_1_PD_1, 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_M, 21, BID_1_PD_N1, 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_A, 21, BID_1_PD_N1, 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_B, 21, BID_1_PD_N1, 0);

            await f.fund.mock.extrapolateNav
                .withArgs(f.startEpoch - EPOCH * 2, parseEther("1000"))
                .returns(parseEther("1"), parseEther("1"), parseEther("1"));
            // User 1 buys M and A and sells B
            await f.exchange.buyM(0, 61, frozenUsdcForM);
            await f.exchange.buyA(0, 61, frozenUsdcForA);
            await f.exchange.sellB(0, 21, frozenB);

            return f;
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = tradeFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        async function expectSettleResult(
            settleFuncName: string,
            user: Wallet,
            epoch: number,
            amountM: BigNumberish,
            amountA: BigNumberish,
            amountB: BigNumberish,
            usdcAmount: BigNumberish
        ) {
            const result = await exchange.callStatic[settleFuncName](user.address, epoch);
            expect(result.amountM).to.equal(amountM);
            expect(result.amountA).to.equal(amountA);
            expect(result.amountB).to.equal(amountB);
            expect(result.quoteAmount).to.equal(usdcAmount);

            const oldM = await exchange.availableBalanceOf(TRANCHE_M, user.address);
            const oldA = await exchange.availableBalanceOf(TRANCHE_A, user.address);
            const oldB = await exchange.availableBalanceOf(TRANCHE_B, user.address);
            await expect(() =>
                exchange[settleFuncName](user.address, epoch)
            ).to.changeTokenBalances(
                usdc,
                [user, exchange],
                [
                    result.quoteAmount.div(USDC_TO_ETHER),
                    result.quoteAmount.div(USDC_TO_ETHER).mul(-1),
                ]
            );
            expect(await exchange.availableBalanceOf(TRANCHE_M, user.address)).to.equal(
                oldM.add(result.amountM)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_A, user.address)).to.equal(
                oldA.add(result.amountA)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_B, user.address)).to.equal(
                oldB.add(result.amountB)
            );
        }

        it("Should revert if price is not available", async function () {
            await twapOracle.mock.getTwap.withArgs(startEpoch + EPOCH).returns(0);
            await expect(exchange.settleMaker(addr1, startEpoch)).to.be.revertedWith(
                "Price is not available"
            );
            await expect(exchange.settleTaker(addr1, startEpoch)).to.be.revertedWith(
                "Price is not available"
            );
        });

        it("Should succeed with no change when settling nothing", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(() =>
                exchange.settleMaker(addr3, startEpoch - EPOCH)
            ).to.changeTokenBalance(usdc, user3, 0);
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr3)).to.equal(USER3_M);
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr3)).to.equal(USER3_A);
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr3)).to.equal(USER3_B);
        });

        describe("Settle at exactly the estimated NAV", function () {
            const navM = parseEther("1");
            const navA = parseEther("1");
            const navB = parseEther("1");
            const settledM = effectiveUsdcForM.mul(parseEther("1")).div(navM);
            const settledA = effectiveUsdcForA.mul(parseEther("1")).div(navA);
            const settledB = frozenB;
            const settledUsdcForM = frozenUsdcForM;
            const settledUsdcForA = frozenUsdcForA;
            const settledUsdcForB = effectiveB.mul(navB).div(parseEther("1"));

            beforeEach(async function () {
                await fund.mock.extrapolateNav.returns(navM, navA, navB);
            });

            it("SettleTaker()", async function () {
                await expectSettleResult(
                    "settleTaker",
                    user1,
                    startEpoch,
                    settledM,
                    settledA,
                    0,
                    settledUsdcForB
                );
            });

            it("SettleMaker()", async function () {
                await expectSettleResult(
                    "settleMaker",
                    user2,
                    startEpoch,
                    reservedM.sub(settledM),
                    reservedA.sub(settledA),
                    settledB,
                    settledUsdcForM.add(settledUsdcForA).add(reservedUsdcForB).sub(settledUsdcForB)
                );
            });

            it("Should emit event", async function () {
                await expect(exchange.settleTaker(addr1, startEpoch))
                    .to.emit(exchange, "TakerSettled")
                    .withArgs(addr1, startEpoch, settledM, settledA, 0, settledUsdcForB);
                await expect(exchange.settleMaker(addr2, startEpoch))
                    .to.emit(exchange, "MakerSettled")
                    .withArgs(
                        addr2,
                        startEpoch,
                        reservedM.sub(settledM),
                        reservedA.sub(settledA),
                        settledB,
                        settledUsdcForM
                            .add(settledUsdcForA)
                            .add(reservedUsdcForB)
                            .sub(settledUsdcForB)
                    );
            });
        });

        describe("Settle at a high price", function () {
            const navM = parseEther("1.2");
            const navA = parseEther("1.05");
            const navB = parseEther("1.35");
            const settledM = effectiveUsdcForM.mul(parseEther("1")).div(navM);
            const settledA = effectiveUsdcForA.mul(parseEther("1")).div(navA);
            const settledB = frozenB
                .mul(reservedUsdcForB)
                .div(effectiveB.mul(navB).div(parseEther("1")));
            const settledUsdcForM = frozenUsdcForM;
            const settledUsdcForA = frozenUsdcForA;
            const settledUsdcForB = reservedUsdcForB;

            beforeEach(async function () {
                await fund.mock.extrapolateNav.returns(navM, navA, navB);
            });

            it("SettleTaker()", async function () {
                await expectSettleResult(
                    "settleTaker",
                    user1,
                    startEpoch,
                    settledM,
                    settledA,
                    frozenB.sub(settledB),
                    settledUsdcForB
                );
            });

            it("SettleMaker()", async function () {
                await expectSettleResult(
                    "settleMaker",
                    user2,
                    startEpoch,
                    reservedM.sub(settledM),
                    reservedA.sub(settledA),
                    settledB,
                    settledUsdcForM.add(settledUsdcForA)
                );
            });
        });

        describe("Settle at a low price", function () {
            const navM = parseEther("0.8");
            const navA = parseEther("1.05");
            const navB = parseEther("0.55");
            const settledM = reservedM;
            const settledA = effectiveUsdcForA.mul(parseEther("1")).div(navA);
            const settledB = frozenB;
            const settledUsdcForM = frozenUsdcForM
                .mul(reservedM.mul(navM).div(parseEther("1")))
                .div(effectiveUsdcForM);
            const settledUsdcForA = frozenUsdcForA;
            const settledUsdcForB = effectiveB.mul(navB).div(parseEther("1"));

            beforeEach(async function () {
                await fund.mock.extrapolateNav.returns(navM, navA, navB);
            });

            it("SettleTaker()", async function () {
                await expectSettleResult(
                    "settleTaker",
                    user1,
                    startEpoch,
                    settledM,
                    settledA,
                    0,
                    settledUsdcForB.add(frozenUsdcForM).sub(settledUsdcForM)
                );
            });

            it("SettleMaker()", async function () {
                await expectSettleResult(
                    "settleMaker",
                    user2,
                    startEpoch,
                    0,
                    reservedA.sub(settledA),
                    settledB,
                    settledUsdcForM.add(settledUsdcForA).add(reservedUsdcForB).sub(settledUsdcForB)
                );
            });
        });
    });

    describe("Settlement with zero NAV", function () {
        it("Buy trade", async function () {
            await exchange.connect(user2).placeAsk(TRANCHE_B, 41, parseEther("10"), 0);

            await fund.mock.extrapolateNav
                .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                .returns(parseEther("1"), parseEther("1"), parseEther("1"));
            await exchange.buyB(0, 41, parseEther("1"));
            await fund.mock.extrapolateNav
                .withArgs(startEpoch + EPOCH, parseEther("1000"))
                .returns(parseEther("0.5"), parseEther("1"), 0);

            // Taker pays nothing and gets all shares
            const takerResult = await exchange.callStatic.settleTaker(addr1, startEpoch);
            expect(takerResult.amountB).to.equal(
                parseEther("1").mul(MAKER_RESERVE_B_BPS).div(10000)
            );
            expect(takerResult.quoteAmount).to.equal(parseEther("1"));

            // Maker sells all shares but gets nothing
            const makerResult = await exchange.callStatic.settleMaker(addr2, startEpoch);
            expect(makerResult.amountB).to.equal(0);
            expect(makerResult.quoteAmount).to.equal(0);
        });

        it("Sell trade", async function () {
            await exchange.connect(user2).placeBid(TRANCHE_B, 41, parseEther("10"), 0);

            await fund.mock.extrapolateNav
                .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                .returns(parseEther("1"), parseEther("1"), parseEther("1"));
            await exchange.sellB(0, 41, parseEther("1"));
            await fund.mock.extrapolateNav
                .withArgs(startEpoch + EPOCH, parseEther("1000"))
                .returns(parseEther("0.5"), parseEther("1"), 0);

            // Taker sells all shares but gets nothing
            const takerResult = await exchange.callStatic.settleTaker(addr1, startEpoch);
            expect(takerResult.amountB).to.equal(0);
            expect(takerResult.quoteAmount).to.equal(0);

            // Maker pays nothing and gets all shares
            const makerResult = await exchange.callStatic.settleMaker(addr2, startEpoch);
            expect(makerResult.amountB).to.equal(parseEther("1"));
            expect(makerResult.quoteAmount).to.equal(
                parseEther("1").mul(MAKER_RESERVE_B_BPS).div(10000)
            );
        });
    });

    describe("applyForMaker()", function () {
        it("Should update maker status", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + 11111);
            await exchange.connect(user3).applyForMaker();

            expect(await exchange.isMaker(addr3)).to.equal(true);
            expect(await exchange.makerExpiration(addr3)).to.equal(startEpoch + 11111);
        });

        it("Should update maker status for non-maker", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch - EPOCH - 11111);
            await exchange.connect(user3).applyForMaker();

            expect(await exchange.isMaker(addr3)).to.equal(false);
            expect(await exchange.makerExpiration(addr3)).to.equal(startEpoch - EPOCH - 11111);
        });

        it("Should update maker status when applying again", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + 11111);
            await exchange.connect(user3).applyForMaker();
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + 22222);
            await exchange.connect(user3).applyForMaker();

            expect(await exchange.isMaker(addr3)).to.equal(true);
            expect(await exchange.makerExpiration(addr3)).to.equal(startEpoch + 22222);
        });

        it("Should emit event", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + 11111);
            await expect(exchange.connect(user3).applyForMaker())
                .to.emit(exchange, "MakerApplied")
                .withArgs(addr3, startEpoch + 11111);
        });

        it("Zero maker requirement", async function () {
            const Exchange = await ethers.getContractFactory("ExchangeV2");
            exchange = await Exchange.connect(owner).deploy(
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
            await expect(exchange.connect(user3).applyForMaker()).to.be.revertedWith(
                "No need to apply for maker"
            );
            expect(await exchange.isMaker(addr3)).to.equal(true);
        });
    });

    describe("Expired ask order", function () {
        let outerFixture: Fixture<FixtureData>;
        const frozenUsdc = parseEther("0.1");
        const reservedB = frozenUsdc.mul(MAKER_RESERVE_B_BPS).div(10000);

        async function expiredAskOrderFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            const u2 = f.wallets.user2;
            const u3 = f.wallets.user3;
            await f.votingEscrow.mock.getTimestampDropBelow
                .withArgs(u3.address, MAKER_REQUIREMENT)
                .returns(f.startEpoch + EPOCH * 9.5);
            await f.exchange.connect(u3).applyForMaker();
            await f.exchange.connect(u3).placeAsk(TRANCHE_B, 41, parseEther("1"), 0);
            await f.exchange.connect(u2).placeAsk(TRANCHE_B, 41, parseEther("1"), 0);
            await f.exchange.connect(u3).placeAsk(TRANCHE_B, 41, parseEther("1"), 0);
            await f.fund.mock.extrapolateNav.returns(0, 0, parseEther("1"));
            // Buy something before user3's orders expire
            await advanceBlockAtTime(f.startEpoch + EPOCH * 9);
            await f.exchange.buyB(0, 41, frozenUsdc);
            // Buy something in the same epoch after user3's orders expire
            await advanceBlockAtTime(f.startEpoch + EPOCH * 9.5);
            await f.exchange.buyB(0, 41, 100);
            return f;
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = expiredAskOrderFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should skip expired order", async function () {
            expect(await exchange.isMaker(addr3)).to.equal(false);
            expect((await exchange.asks(0, TRANCHE_B, 41)).head).to.equal(2);
            const user3Trade = await exchange.unsettledTrades(
                addr3,
                TRANCHE_B,
                startEpoch + EPOCH * 10
            );
            expect(user3Trade.makerSell.reservedBase).to.equal(reservedB);
        });

        it("Should not match skipped order even after maker applying again", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + EPOCH * 19);
            await exchange.connect(user3).applyForMaker();
            expect(await exchange.isMaker(addr3)).to.equal(true);

            // User3's order at index 1 has been skipped and cannot be matched forever.
            await exchange.buyB(0, 41, 300);
            expect((await exchange.asks(0, TRANCHE_B, 41)).head).to.equal(2);
            const user3Trade = await exchange.unsettledTrades(
                addr3,
                TRANCHE_B,
                startEpoch + EPOCH * 10
            );
            expect(user3Trade.makerSell.reservedBase).to.equal(reservedB);
        });

        it("Should match order that was expired but not skipped", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + EPOCH * 20);
            await exchange.connect(user3).applyForMaker();
            expect(await exchange.isMaker(addr3)).to.equal(true);

            // User3's order at index 3 can be matched even if it was expired
            // for a short period of time.
            await exchange.buyB(0, 41, parseEther("100"));
            expect(await exchange.bestAsks(0, TRANCHE_B)).to.equal(82);
            const user3Trade = await exchange.unsettledTrades(
                addr3,
                TRANCHE_B,
                startEpoch + EPOCH * 10
            );
            expect(user3Trade.makerSell.reservedBase).to.equal(reservedB.add(parseEther("1")));
        });

        it("Should cancel skipped order", async function () {
            const oldB = await exchange.availableBalanceOf(TRANCHE_B, addr3);
            await exchange.connect(user3).cancelAsk(0, TRANCHE_B, 41, 1);
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr3)).to.equal(
                oldB.add(parseEther("1").sub(reservedB))
            );
            const order = await exchange.getAskOrder(0, TRANCHE_B, 41, 1);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.fillable).to.equal(0);
        });
    });

    describe("Expired bid order", function () {
        let outerFixture: Fixture<FixtureData>;
        const frozenA = parseEther("0.1");
        const reservedUsdc = frozenA.mul(MAKER_RESERVE_A_BPS).div(10000);

        async function expiredBidOrderFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            const u2 = f.wallets.user2;
            const u3 = f.wallets.user3;
            await f.votingEscrow.mock.getTimestampDropBelow
                .withArgs(u3.address, MAKER_REQUIREMENT)
                .returns(f.startEpoch + EPOCH * 9.5);
            await f.exchange.connect(u3).applyForMaker();
            await f.exchange.connect(u3).placeBid(TRANCHE_A, 41, parseEther("1"), 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_A, 41, parseEther("1"), 0);
            await f.exchange.connect(u3).placeBid(TRANCHE_A, 41, parseEther("1"), 0);
            await f.fund.mock.extrapolateNav.returns(0, parseEther("1"), 0);
            // Sell something before user3's orders expire
            await advanceBlockAtTime(f.startEpoch + EPOCH * 9);
            await f.exchange.sellA(0, 41, frozenA);
            // Sell something in the same epoch after user3's orders expire
            await advanceBlockAtTime(f.startEpoch + EPOCH * 9.5);
            await f.exchange.sellA(0, 41, 100);
            return f;
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = expiredBidOrderFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should skip expired order", async function () {
            expect(await exchange.isMaker(addr3)).to.equal(false);
            expect((await exchange.bids(0, TRANCHE_A, 41)).head).to.equal(2);
            const user3Trade = await exchange.unsettledTrades(
                addr3,
                TRANCHE_A,
                startEpoch + EPOCH * 10
            );
            expect(user3Trade.makerBuy.reservedQuote).to.equal(reservedUsdc);
        });

        it("Should not match skipped order even after maker applying again", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + EPOCH * 19);
            await exchange.connect(user3).applyForMaker();
            expect(await exchange.isMaker(addr3)).to.equal(true);

            // User3's order at index 1 has been skipped and cannot be matched forever.
            await exchange.sellA(0, 41, 300);
            expect((await exchange.bids(0, TRANCHE_A, 41)).head).to.equal(2);
            const user3Trade = await exchange.unsettledTrades(
                addr3,
                TRANCHE_A,
                startEpoch + EPOCH * 10
            );
            expect(user3Trade.makerBuy.reservedQuote).to.equal(reservedUsdc);
        });

        it("Should match order that was expired but not skipped", async function () {
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(addr3, MAKER_REQUIREMENT)
                .returns(startEpoch + EPOCH * 20);
            await exchange.connect(user3).applyForMaker();
            expect(await exchange.isMaker(addr3)).to.equal(true);

            // User3's order at index 3 can be matched even if it was expired
            // for a short period of time.
            await exchange.sellA(0, 41, parseEther("100"));
            expect(await exchange.bestBids(0, TRANCHE_A)).to.equal(0);
            const user3Trade = await exchange.unsettledTrades(
                addr3,
                TRANCHE_A,
                startEpoch + EPOCH * 10
            );
            expect(user3Trade.makerBuy.reservedQuote).to.equal(reservedUsdc.add(parseEther("1")));
        });

        it("Should cancel skipped order", async function () {
            const fillableUsdc = parseEther("1").sub(reservedUsdc);
            await expect(() =>
                exchange.connect(user3).cancelBid(0, TRANCHE_A, 41, 1)
            ).to.changeTokenBalances(
                usdc,
                [user3, exchange],
                [fillableUsdc.div(USDC_TO_ETHER), fillableUsdc.div(USDC_TO_ETHER).mul(-1)]
            );
            const order = await exchange.getBidOrder(0, TRANCHE_A, 41, 1);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.fillable).to.equal(0);
        });
    });

    describe("Rebalance", function () {
        beforeEach(async function () {
            await fund.mock.getRebalanceSize.returns(1);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(startEpoch + EPOCH * 5);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(startEpoch + EPOCH * 15);
            await fund.mock.getRebalanceTimestamp.withArgs(2).returns(startEpoch + EPOCH * 20);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 1)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 2)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 0)
                .returns(USER1_M, USER1_A, USER1_B);
            await fund.mock.doRebalance
                .withArgs(USER2_M, USER2_A, USER2_B, 0)
                .returns(USER2_M, USER2_A, USER2_B);
            await advanceBlockAtTime(startEpoch + EPOCH * 9);
        });

        it("Should rebalance on cancellation", async function () {
            await exchange.placeAsk(TRANCHE_A, 41, parseEther("1"), 1);
            await exchange.placeAsk(TRANCHE_A, 41, parseEther("2"), 1);

            // Cancel the first order after two rebalances
            await advanceBlockAtTime(startEpoch + EPOCH * 30);
            await fund.mock.getRebalanceSize.returns(3);
            await expect(() => exchange.cancelAsk(1, TRANCHE_A, 41, 1)).to.callMocks(
                {
                    // Rebalance available balance from version 1 to 2
                    func: fund.mock.doRebalance.withArgs(
                        USER1_M,
                        USER1_A.sub(parseEther("3")),
                        USER1_B,
                        1
                    ),
                    rets: [11111, 2222, 333],
                },
                {
                    // Rebalance locked balance from version 1 to 2
                    func: fund.mock.doRebalance.withArgs(0, parseEther("3"), 0, 1),
                    rets: [7777, 888, 99],
                },
                {
                    // Rebalance available balance from version 2 to 3
                    func: fund.mock.doRebalance.withArgs(11111, 2222, 333, 2),
                    rets: [10000, 2000, 300],
                },
                {
                    // Rebalance locked balance from version 2 to 3
                    func: fund.mock.doRebalance.withArgs(7777, 888, 99, 2),
                    rets: [7000, 800, 90],
                },
                {
                    // Rebalance order amount from version 1 to 3
                    func: fund.mock.batchRebalance.withArgs(0, parseEther("1"), 0, 1, 3),
                    rets: [4000, 500, 60],
                }
            );
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(10000 + 4000);
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr1)).to.equal(2000 + 500);
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr1)).to.equal(300 + 60);
        });

        it("Should rebalance on settlement", async function () {
            const frozenUsdc = parseEther("1");
            const orderA = parseEther("2");
            const reservedA = parseEther("1").mul(MAKER_RESERVE_A_BPS).div(10000);
            const settledA = parseEther("1");
            await fund.mock.extrapolateNav.returns(0, parseEther("1"), 0);
            await exchange.connect(user2).placeAsk(TRANCHE_A, 41, orderA, 1);
            await exchange.buyA(1, 41, frozenUsdc);

            // Settle the taker's trade after two rebalances
            await advanceBlockAtTime(startEpoch + EPOCH * 30);
            await fund.mock.getRebalanceSize.returns(3);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A.sub(reservedA), TOTAL_B, 1)
                .returns(11111, 2222, 333);
            await fund.mock.doRebalance.withArgs(11111, 2222, 333, 2).returns(10000, 2000, 300);
            await expect(() => exchange.settleTaker(addr1, startEpoch + EPOCH * 10)).to.callMocks(
                {
                    // Rebalance available balance from version 1 to 2
                    func: fund.mock.doRebalance.withArgs(USER1_M, USER1_A, USER1_B, 1),
                    rets: [4444, 555, 66],
                },
                {
                    // Rebalance available balance from version 2 to 3
                    func: fund.mock.doRebalance.withArgs(4444, 555, 66, 2),
                    rets: [4000, 500, 60],
                },
                {
                    // Rebalance settled amount from version 1 to 3
                    func: fund.mock.batchRebalance.withArgs(0, settledA, 0, 1, 3),
                    rets: [700, 80, 9],
                }
            );
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr1)).to.equal(4000 + 700);
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr1)).to.equal(500 + 80);
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr1)).to.equal(60 + 9);

            // Settle the maker's trade after two rebalances
            await expect(() => exchange.settleMaker(addr2, startEpoch + EPOCH * 10)).to.callMocks(
                {
                    // Rebalance available balance from version 1 to 2
                    func: fund.mock.doRebalance.withArgs(USER2_M, USER2_A.sub(orderA), USER2_B, 1),
                    rets: [4444, 555, 66],
                },
                {
                    // Rebalance locked balance from version 1 to 2
                    func: fund.mock.doRebalance.withArgs(0, orderA.sub(reservedA), 0, 1),
                    rets: [7777, 888, 99],
                },
                {
                    // Rebalance available balance from version 2 to 3
                    func: fund.mock.doRebalance.withArgs(4444, 555, 66, 2),
                    rets: [4000, 500, 60],
                },
                {
                    // Rebalance locked balance from version 2 to 3
                    func: fund.mock.doRebalance.withArgs(7777, 888, 99, 2),
                    rets: [7000, 800, 90],
                },
                {
                    // Rebalance settled amount from version 1 to 3
                    func: fund.mock.batchRebalance.withArgs(0, reservedA.sub(settledA), 0, 1, 3),
                    rets: [100, 20, 3],
                }
            );
            expect(await exchange.availableBalanceOf(TRANCHE_M, addr2)).to.equal(4000 + 100);
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr2)).to.equal(500 + 20);
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr2)).to.equal(60 + 3);
        });

        it("Should start a new order book after rebalance", async function () {
            await fund.mock.extrapolateNav.returns(0, parseEther("1"), 0);
            await exchange.connect(user2).placeAsk(TRANCHE_A, 45, parseEther("1"), 1);
            await exchange.connect(user2).placeBid(TRANCHE_A, 37, parseEther("1"), 1);

            await advanceBlockAtTime(startEpoch + EPOCH * 30);
            await fund.mock.getRebalanceSize.returns(3);
            await expect(exchange.buyA(1, 81, 100)).to.be.revertedWith("Invalid version");
            await expect(exchange.sellA(1, 1, 100)).to.be.revertedWith("Invalid version");
            await expect(exchange.buyA(3, 81, 100)).to.be.revertedWith(
                "Nothing can be bought at the given premium-discount level"
            );
            await expect(exchange.sellA(3, 1, 100)).to.be.revertedWith(
                "Nothing can be sold at the given premium-discount level"
            );
        });
    });

    describe("Safe transfer", function () {
        let mockUsdc: MockContract;

        beforeEach(async function () {
            // Deploy a new Exchange using a mocked quote token
            mockUsdc = await deployMockForName(owner, "IERC20");
            const Exchange = await ethers.getContractFactory("ExchangeV2");
            exchange = await Exchange.connect(owner).deploy(
                fund.address,
                chessSchedule.address,
                chessController.address,
                mockUsdc.address,
                6,
                votingEscrow.address,
                MIN_BID_AMOUNT,
                MIN_ASK_AMOUNT,
                MAKER_REQUIREMENT,
                0,
                0
            );
            exchange = exchange.connect(user1);
            await votingEscrow.mock.getTimestampDropBelow
                .withArgs(user1.address, MAKER_REQUIREMENT)
                .returns(startEpoch + EPOCH * 500);
            await exchange.applyForMaker();
        });

        it("Should check return value of transferFrom()", async function () {
            await mockUsdc.mock.transferFrom
                .withArgs(addr1, exchange.address, parseUsdc("10"))
                .returns(false);
            await expect(exchange.placeBid(TRANCHE_A, 41, parseEther("10"), 0)).to.be.revertedWith(
                "SafeERC20: ERC20 operation did not succeed"
            );
        });

        it("Should check return value of transfer()", async function () {
            await mockUsdc.mock.transferFrom.returns(true);
            await exchange.placeBid(TRANCHE_A, 41, parseEther("10"), 0);
            await mockUsdc.mock.transfer.withArgs(addr1, parseUsdc("10")).returns(false);
            await expect(exchange.cancelBid(0, TRANCHE_A, 41, 1)).to.be.revertedWith(
                "SafeERC20: ERC20 operation did not succeed"
            );
        });
    });

    describe("Miscellaneous", function () {
        it("Should be properly initialized in a proxy's point of view", async function () {
            expect(await exchange.fund()).to.equal(fund.address);
            expect(await exchange.minBidAmount()).to.equal(MIN_BID_AMOUNT);
            expect(await exchange.minAskAmount()).to.equal(MIN_ASK_AMOUNT);
            expect(await exchange.makerRequirement()).to.equal(MAKER_REQUIREMENT);
        });

        it("Should revert if initialized again", async function () {
            await expect(exchange.initialize()).to.be.reverted;
            await expect(exchange.initializeV2(owner.address)).to.be.reverted;
        });

        it("Should check quote decimal places", async function () {
            const Exchange = await ethers.getContractFactory("ExchangeV2");
            await expect(
                Exchange.connect(owner).deploy(
                    fund.address,
                    chessSchedule.address,
                    chessController.address,
                    usdc.address,
                    19,
                    votingEscrow.address,
                    MIN_BID_AMOUNT,
                    MIN_ASK_AMOUNT,
                    MAKER_REQUIREMENT,
                    0,
                    0
                )
            ).to.be.revertedWith("Quote asset decimals larger than 18");
        });

        it("Should correctly handle uninitialized best ask", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.buyB(0, 81, 1)).to.be.revertedWith(
                "Nothing can be bought at the given premium-discount level"
            );
        });
    });

    describe("Guarded launch", function () {
        const guardedLaunchMinOrderAmount = MIN_BID_AMOUNT.lt(MIN_ASK_AMOUNT)
            ? MIN_BID_AMOUNT.div(2)
            : MIN_ASK_AMOUNT.div(2);
        let guardedLaunchStart: number;

        beforeEach(async function () {
            guardedLaunchStart = startEpoch + 12345;

            const Exchange = await ethers.getContractFactory("ExchangeV2");
            exchange = await Exchange.connect(owner).deploy(
                fund.address,
                chessSchedule.address,
                chessController.address,
                usdc.address,
                6,
                votingEscrow.address,
                MIN_BID_AMOUNT,
                MIN_ASK_AMOUNT,
                0,
                guardedLaunchStart,
                guardedLaunchMinOrderAmount
            );
            exchange = exchange.connect(user1);

            await shareM.mock.transferFrom.returns(true);
            await exchange.connect(user1).deposit(TRANCHE_M, USER1_M);
            await usdc.connect(user1).approve(exchange.address, USER1_USDC.div(USDC_TO_ETHER));
        });

        it("Should allow placing maker orders after 8 days", async function () {
            await advanceBlockAtTime(guardedLaunchStart + DAY * 8 - 100);
            await expect(exchange.placeBid(TRANCHE_M, 40, parseEther("1"), 0)).to.be.revertedWith(
                "Guarded launch: market closed"
            );
            await expect(exchange.placeAsk(TRANCHE_M, 42, parseEther("1"), 0)).to.be.revertedWith(
                "Guarded launch: market closed"
            );

            await advanceBlockAtTime(guardedLaunchStart + DAY * 8);
            await exchange.placeBid(TRANCHE_M, 40, parseEther("1"), 0);
            await exchange.placeAsk(TRANCHE_M, 42, parseEther("1"), 0);
        });

        it("Should check min order amount", async function () {
            await advanceBlockAtTime(guardedLaunchStart + WEEK * 4 - 100);
            await expect(
                exchange.placeBid(TRANCHE_M, 40, guardedLaunchMinOrderAmount.sub(1), 0)
            ).to.be.revertedWith("Guarded launch: amount too low");
            await expect(
                exchange.placeAsk(TRANCHE_M, 42, guardedLaunchMinOrderAmount.sub(1), 0)
            ).to.be.revertedWith("Guarded launch: amount too low");
            await exchange.placeBid(TRANCHE_M, 40, guardedLaunchMinOrderAmount, 0);
            await exchange.placeAsk(TRANCHE_M, 42, guardedLaunchMinOrderAmount, 0);

            await advanceBlockAtTime(guardedLaunchStart + WEEK * 4);
            await expect(
                exchange.placeBid(TRANCHE_M, 40, guardedLaunchMinOrderAmount, 0)
            ).to.be.revertedWith("Quote amount too low");
            await expect(
                exchange.placeAsk(TRANCHE_M, 42, guardedLaunchMinOrderAmount, 0)
            ).to.be.revertedWith("Base amount too low");
        });
    });

    describe("pause() and unpause()", function () {
        it("Should pause placeBid()", async function () {
            await shareM.mock.transferFrom.returns(true);
            await exchange.connect(owner).pause();
            await expect(exchange.placeBid(TRANCHE_M, 41, parseEther("1"), 0)).to.be.revertedWith(
                "Pausable: paused"
            );
            await exchange.connect(owner).unpause();
            await exchange.placeBid(TRANCHE_M, 41, parseEther("1"), 0);
        });

        it("Should pause placeAsk()", async function () {
            await exchange.connect(owner).pause();
            await expect(exchange.placeAsk(TRANCHE_M, 41, parseEther("1"), 0)).to.be.revertedWith(
                "Pausable: paused"
            );
            await exchange.connect(owner).unpause();
            await exchange.placeAsk(TRANCHE_M, 41, parseEther("1"), 0);
        });

        it("Should pause cancelBid()", async function () {
            await shareM.mock.transferFrom.returns(true);
            await exchange.placeBid(TRANCHE_M, 41, parseEther("1"), 0);
            await exchange.connect(owner).pause();
            await expect(exchange.cancelBid(0, TRANCHE_M, 41, 1)).to.be.revertedWith(
                "Pausable: paused"
            );
            await exchange.connect(owner).unpause();
            await exchange.cancelBid(0, TRANCHE_M, 41, 1);
        });

        it("Should pause cancelAsk()", async function () {
            await exchange.placeAsk(TRANCHE_M, 41, parseEther("1"), 0);
            await exchange.connect(owner).pause();
            await expect(exchange.cancelAsk(0, TRANCHE_M, 41, 1)).to.be.revertedWith(
                "Pausable: paused"
            );
            await exchange.connect(owner).unpause();
            await exchange.cancelAsk(0, TRANCHE_M, 41, 1);
        });

        it("Should pause buyM(), buyA() and buyB()", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await exchange.placeAsk(TRANCHE_M, 41, parseEther("1"), 0);
            await exchange.placeAsk(TRANCHE_A, 41, parseEther("1"), 0);
            await exchange.placeAsk(TRANCHE_B, 41, parseEther("1"), 0);
            await exchange.connect(owner).pause();
            await expect(exchange.buyM(0, 41, parseEther("1"))).to.be.revertedWith(
                "Pausable: paused"
            );
            await expect(exchange.buyA(0, 41, parseEther("1"))).to.be.revertedWith(
                "Pausable: paused"
            );
            await expect(exchange.buyB(0, 41, parseEther("1"))).to.be.revertedWith(
                "Pausable: paused"
            );
            await exchange.connect(owner).unpause();
            await exchange.buyM(0, 41, parseEther("1"));
            await exchange.buyA(0, 41, parseEther("1"));
            await exchange.buyB(0, 41, parseEther("1"));
        });

        it("Should pause sellM(), sellA() and sellB()", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await exchange.placeBid(TRANCHE_M, 41, parseEther("1"), 0);
            await exchange.placeBid(TRANCHE_A, 41, parseEther("1"), 0);
            await exchange.placeBid(TRANCHE_B, 41, parseEther("1"), 0);
            await exchange.connect(owner).pause();
            await expect(exchange.sellM(0, 41, parseEther("1"))).to.be.revertedWith(
                "Pausable: paused"
            );
            await expect(exchange.sellA(0, 41, parseEther("1"))).to.be.revertedWith(
                "Pausable: paused"
            );
            await expect(exchange.sellB(0, 41, parseEther("1"))).to.be.revertedWith(
                "Pausable: paused"
            );
            await exchange.connect(owner).unpause();
            await exchange.sellM(0, 41, parseEther("1"));
            await exchange.sellA(0, 41, parseEther("1"));
            await exchange.sellB(0, 41, parseEther("1"));
        });

        it("Should pause settleMaker() and settleTaker()", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await exchange.placeAsk(TRANCHE_M, 41, parseEther("1"), 0);
            await exchange.buyM(0, 41, parseEther("1"));
            await exchange.connect(owner).pause();
            await expect(exchange.settleMaker(addr1, startEpoch)).to.be.revertedWith(
                "Pausable: paused"
            );
            await expect(exchange.settleTaker(addr1, startEpoch)).to.be.revertedWith(
                "Pausable: paused"
            );
            await exchange.connect(owner).unpause();
            await exchange.settleMaker(addr1, startEpoch);
            await exchange.settleTaker(addr1, startEpoch);
        });
    });

    describe.skip("Gas used", function () {
        let estimatedGasInBuy: BigNumberish;
        let estimatedGasInSell: BigNumberish;
        let gasInBuy: BigNumberish;
        let gasInSell: BigNumberish;

        it("Measures gas used in matching 25 maker orders", async function () {
            this.timeout(300000); // 5 minutes
            for (let i = 0; i < 5; i++) {
                for (let j = 0; j < 5; j++) {
                    await exchange.connect(user2).placeAsk(TRANCHE_B, 42 + i, parseEther("1"), 0);
                    await exchange.connect(user2).placeBid(TRANCHE_B, 40 - i, parseEther("1"), 0);
                }
            }
            await fund.mock.extrapolateNav.returns(0, 0, parseEther("1"));

            estimatedGasInBuy = await exchange.estimateGas.buyB(0, 71, parseEther("10000"));
            const buyTx = await exchange.buyB(0, 71, parseEther("10000"));
            gasInBuy = (await ethers.provider.getTransactionReceipt(buyTx.hash)).gasUsed;

            estimatedGasInSell = await exchange.estimateGas.sellB(0, 11, parseEther("10000"));
            const sellTx = await exchange.sellB(0, 11, parseEther("10000"));
            gasInSell = (await ethers.provider.getTransactionReceipt(sellTx.hash)).gasUsed;
        });

        after(function () {
            console.log(`Gas used in buy: estimated ${estimatedGasInBuy}, actual ${gasInBuy}`);
            console.log(`Gas used in sell: estimated ${estimatedGasInSell}, actual ${gasInSell}`);
        });
    });
});
