import { expect } from "chai";
import { BigNumber, BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseUsdc = (value: string) => parseUnits(value, 6);
import { deployMockForName } from "./mock";

const MAX_UINT = BigNumber.from("2").pow(256).sub(1);
const EPOCH = 1800; // 30 min
const USDC_TO_ETHER = parseUnits("1", 12);
const MAKER_RESERVE_BPS = 11000; // 110%
const TRANCHE_P = 0;
const TRANCHE_A = 1;
const TRANCHE_B = 2;

const USER1_USDC = parseEther("100000");
const USER1_P = parseEther("10000");
const USER1_A = parseEther("20000");
const USER1_B = parseEther("30000");
const USER2_USDC = parseEther("200000");
const USER2_P = parseEther("20000");
const USER2_A = parseEther("40000");
const USER2_B = parseEther("60000");
const USER3_USDC = parseEther("300000");
const USER3_P = parseEther("30000");
const USER3_A = parseEther("60000");
const USER3_B = parseEther("90000");
const MIN_BID_AMOUNT = parseEther("0.8");
const MIN_ASK_AMOUNT = parseEther("0.9");
const MAKER_REQUIREMENT = parseEther("10000");

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

describe("Exchange", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startEpoch: number;
        readonly fund: MockContract;
        readonly shareP: MockContract;
        readonly shareA: MockContract;
        readonly shareB: MockContract;
        readonly twapOracle: MockContract;
        readonly chess: MockContract;
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
    let shareP: MockContract;
    let shareA: MockContract;
    let shareB: MockContract;
    let twapOracle: MockContract;
    let chess: MockContract;
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
        const shareP = await deployMockForName(owner, "IERC20");
        const shareA = await deployMockForName(owner, "IERC20");
        const shareB = await deployMockForName(owner, "IERC20");
        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        await fund.mock.tokenP.returns(shareP.address);
        await fund.mock.tokenA.returns(shareA.address);
        await fund.mock.tokenB.returns(shareB.address);
        await fund.mock.getConversionSize.returns(0);
        await fund.mock.twapOracle.returns(twapOracle.address);
        await fund.mock.isExchangeActive.returns(true);
        await twapOracle.mock.getTwap.returns(parseEther("1000"));

        const chess = await deployMockForName(owner, "IChess");
        await chess.mock.getRate.returns(0);

        const chessController = await deployMockForName(owner, "IChessController");
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");

        const Exchange = await ethers.getContractFactory("Exchange");
        const exchangeImpl = await Exchange.connect(owner).deploy(
            fund.address,
            chess.address,
            chessController.address,
            usdc.address,
            6,
            votingEscrow.address,
            MIN_BID_AMOUNT,
            MIN_ASK_AMOUNT,
            MAKER_REQUIREMENT
        );
        const TranchessProxy = await ethers.getContractFactory("TranchessProxy");
        const exchangeProxy = await TranchessProxy.connect(owner).deploy(
            exchangeImpl.address,
            owner.address,
            "0x"
        );
        const exchange = Exchange.attach(exchangeProxy.address);

        // Initialize balance
        await shareP.mock.transferFrom.returns(true);
        await shareA.mock.transferFrom.returns(true);
        await shareB.mock.transferFrom.returns(true);
        await exchange.connect(user1).deposit(TRANCHE_P, USER1_P);
        await exchange.connect(user1).deposit(TRANCHE_A, USER1_A);
        await exchange.connect(user1).deposit(TRANCHE_B, USER1_B);
        await exchange.connect(user2).deposit(TRANCHE_P, USER2_P);
        await exchange.connect(user2).deposit(TRANCHE_A, USER2_A);
        await exchange.connect(user2).deposit(TRANCHE_B, USER2_B);
        await exchange.connect(user3).deposit(TRANCHE_P, USER3_P);
        await exchange.connect(user3).deposit(TRANCHE_A, USER3_A);
        await exchange.connect(user3).deposit(TRANCHE_B, USER3_B);
        await shareP.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
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
            shareP,
            shareA,
            shareB,
            twapOracle,
            chess,
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
        shareP = fixtureData.shareP;
        shareA = fixtureData.shareA;
        shareB = fixtureData.shareB;
        twapOracle = fixtureData.twapOracle;
        chess = fixtureData.chess;
        chessController = fixtureData.chessController;
        usdc = fixtureData.usdc;
        votingEscrow = fixtureData.votingEscrow;
        exchange = fixtureData.exchange;

        tranche_list = [
            { tranche: TRANCHE_P, share: shareP },
            { tranche: TRANCHE_A, share: shareA },
            { tranche: TRANCHE_B, share: shareB },
        ];
    });

    describe("Proxy", function () {
        it("Should be properly initialized in a proxy's point of view", async function () {
            expect(await exchange.fund()).to.equal(fund.address);
            expect(await exchange.tokenP()).to.equal(shareP.address);
            expect(await exchange.tokenA()).to.equal(shareA.address);
            expect(await exchange.tokenB()).to.equal(shareB.address);
            expect(await exchange.minBidAmount()).to.equal(MIN_BID_AMOUNT);
            expect(await exchange.minAskAmount()).to.equal(MIN_ASK_AMOUNT);
            expect(await exchange.makerRequirement()).to.equal(MAKER_REQUIREMENT);
        });
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
                exchange.connect(user3).placeBid(TRANCHE_P, 1, MIN_BID_AMOUNT, 0, 0)
            ).to.be.revertedWith("Only maker");
            await advanceBlockAtTime(startEpoch + EPOCH * 1500);
            await expect(exchange.placeBid(TRANCHE_P, 1, MIN_BID_AMOUNT, 0, 0)).to.be.revertedWith(
                "Only maker"
            );
        });

        it("Should check min amount", async function () {
            await expect(
                exchange.placeBid(TRANCHE_P, 1, MIN_BID_AMOUNT.sub(1), 0, 0)
            ).to.be.revertedWith("Quote amount too low");
        });

        it("Should check pd level", async function () {
            await expect(exchange.placeBid(TRANCHE_P, 0, MIN_BID_AMOUNT, 0, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.placeBid(TRANCHE_P, 82, MIN_BID_AMOUNT, 0, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );

            await exchange.placeAsk(TRANCHE_P, 41, parseEther("1"), 0, 0);
            await expect(exchange.placeBid(TRANCHE_P, 41, MIN_BID_AMOUNT, 0, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should check conversion ID", async function () {
            await expect(exchange.placeBid(TRANCHE_P, 1, MIN_BID_AMOUNT, 1, 0)).to.be.revertedWith(
                "Invalid conversion ID"
            );
        });

        it("Should transfer USDC", async function () {
            for (const { tranche } of tranche_list) {
                await expect(() =>
                    exchange.placeBid(tranche, 1, parseEther("100"), 0, 0)
                ).to.changeTokenBalances(
                    usdc,
                    [user1, exchange],
                    [parseUsdc("-100"), parseUsdc("100")]
                );
            }
        });

        it("Should update best bid premium-discount level", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeBid(tranche, 41, parseEther("100"), 0, 0);
                expect(await exchange.bestBids(0, tranche)).to.equal(41);
                await exchange.placeBid(tranche, 61, parseEther("100"), 0, 0);
                expect(await exchange.bestBids(0, tranche)).to.equal(61);
                await exchange.placeBid(tranche, 51, parseEther("100"), 0, 0);
                expect(await exchange.bestBids(0, tranche)).to.equal(61);
            }
        });

        it("Should append order to order queue", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeBid(tranche, 41, parseEther("100"), 0, 0);
                const order1 = await exchange.getBidOrder(0, tranche, 41, 1);
                expect(order1.maker).to.equal(addr1);
                expect(order1.amount).to.equal(parseEther("100"));
                expect(order1.fillable).to.equal(parseEther("100"));

                await exchange.connect(user2).placeBid(tranche, 41, parseEther("200"), 0, 0);
                const order2 = await exchange.getBidOrder(0, tranche, 41, 2);
                expect(order2.maker).to.equal(addr2);
                expect(order2.amount).to.equal(parseEther("200"));
                expect(order2.fillable).to.equal(parseEther("200"));
            }
        });
    });

    describe("placeAsk()", function () {
        it("Should check maker expiration", async function () {
            await expect(
                exchange.connect(user3).placeAsk(TRANCHE_P, 81, MIN_ASK_AMOUNT, 0, 0)
            ).to.be.revertedWith("Only maker");
            await advanceBlockAtTime(startEpoch + EPOCH * 1000);
            await expect(exchange.placeAsk(TRANCHE_P, 81, MIN_ASK_AMOUNT, 0, 0)).to.be.revertedWith(
                "Only maker"
            );
        });

        it("Should check min amount", async function () {
            await expect(
                exchange.placeAsk(TRANCHE_P, 81, MIN_ASK_AMOUNT.sub(1), 0, 0)
            ).to.be.revertedWith("Base amount too low");
        });

        it("Should check pd level", async function () {
            await expect(exchange.placeAsk(TRANCHE_P, 0, MIN_ASK_AMOUNT, 0, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.placeAsk(TRANCHE_P, 82, MIN_ASK_AMOUNT, 0, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );

            await exchange.placeBid(TRANCHE_P, 41, parseEther("100"), 0, 0);
            await expect(exchange.placeAsk(TRANCHE_P, 41, MIN_ASK_AMOUNT, 0, 0)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should check conversion ID", async function () {
            await expect(exchange.placeAsk(TRANCHE_P, 81, MIN_ASK_AMOUNT, 1, 0)).to.be.revertedWith(
                "Invalid conversion ID"
            );
        });

        it("Should lock share tokens", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeAsk(tranche, 81, parseEther("100"), 0, 0);
                expect(await exchange.lockedBalanceOf(tranche, addr1)).to.equal(parseEther("100"));
            }
        });

        it("Should revert if balance is not enough", async function () {
            await expect(exchange.placeAsk(TRANCHE_P, 81, USER1_P.add(1), 0, 0)).to.be.revertedWith(
                "Insufficient balance to lock"
            );
            await expect(exchange.placeAsk(TRANCHE_A, 81, USER1_A.add(1), 0, 0)).to.be.revertedWith(
                "Insufficient balance to lock"
            );
            await expect(exchange.placeAsk(TRANCHE_B, 81, USER1_B.add(1), 0, 0)).to.be.revertedWith(
                "Insufficient balance to lock"
            );
        });

        it("Should update best ask premium-discount level", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeAsk(tranche, 41, parseEther("1"), 0, 0);
                expect(await exchange.bestAsks(0, tranche)).to.equal(41);
                await exchange.placeAsk(tranche, 21, parseEther("1"), 0, 0);
                expect(await exchange.bestAsks(0, tranche)).to.equal(21);
                await exchange.placeAsk(tranche, 31, parseEther("1"), 0, 0);
                expect(await exchange.bestAsks(0, tranche)).to.equal(21);
            }
        });

        it("Should append order to order queue", async function () {
            for (const { tranche } of tranche_list) {
                await exchange.placeAsk(tranche, 41, parseEther("1"), 0, 0);
                const order1 = await exchange.getAskOrder(0, tranche, 41, 1);
                expect(order1.maker).to.equal(addr1);
                expect(order1.amount).to.equal(parseEther("1"));
                expect(order1.fillable).to.equal(parseEther("1"));

                await exchange.connect(user2).placeAsk(tranche, 41, parseEther("2"), 0, 0);
                const order2 = await exchange.getAskOrder(0, tranche, 41, 2);
                expect(order2.maker).to.equal(addr2);
                expect(order2.amount).to.equal(parseEther("2"));
                expect(order2.fillable).to.equal(parseEther("2"));
            }
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

        // Order book of Share P
        // Ask:
        // +2%   60(user3)
        // +1%   20(user2)  30(user3)  50(user2)
        //  0%  100(user2)
        await f.exchange.connect(u3).placeAsk(TRANCHE_P, 49, ASK_1_PD_2, 0, 0);
        await f.exchange.connect(u2).placeAsk(TRANCHE_P, 45, ASK_1_PD_1, 0, 0);
        await f.exchange.connect(u3).placeAsk(TRANCHE_P, 45, ASK_2_PD_1, 0, 0);
        await f.exchange.connect(u2).placeAsk(TRANCHE_P, 45, ASK_3_PD_1, 0, 0);
        await f.exchange.connect(u2).placeAsk(TRANCHE_P, 41, ASK_1_PD_0, 0, 0);

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

        // Order book of Share P
        // Bid:
        //  0%  100(user2)
        // -1%   50(user3)  20(user2)  30(user2)
        // -2%   80(user3)
        await f.exchange.connect(u2).placeBid(TRANCHE_P, 41, BID_1_PD_0, 0, 0);
        await f.exchange.connect(u3).placeBid(TRANCHE_P, 37, BID_1_PD_N1, 0, 0);
        await f.exchange.connect(u2).placeBid(TRANCHE_P, 37, BID_2_PD_N1, 0, 0);
        await f.exchange.connect(u2).placeBid(TRANCHE_P, 37, BID_3_PD_N1, 0, 0);
        await f.exchange.connect(u3).placeBid(TRANCHE_P, 33, BID_1_PD_N2, 0, 0);

        return f;
    }

    describe("buyP()", function () {
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
            await expect(exchange.buyP(0, 41, 1)).to.be.revertedWith("Exchange is inactive");
        });

        it("Should revert if price is not available", async function () {
            await twapOracle.mock.getTwap.returns(0);
            await expect(exchange.buyP(0, 41, 1)).to.be.revertedWith("Price is not available");
        });

        it("Should check pd level", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.buyP(0, 0, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.buyP(0, 82, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should revert if no order can be matched", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.buyP(0, 40, 1)).to.be.revertedWith(
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
                .mul(MAKER_RESERVE_BPS)
                .div(10000)
                .mul(parseEther("1"))
                .div(estimatedNav);
            const buyTxBuilder = () => exchange.buyP(0, 49, matchedUsdc);

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
                const order = await exchange.getAskOrder(0, TRANCHE_P, 41, 1);
                expect(order.fillable).to.equal(ASK_1_PD_0.sub(matchedShares));
            });

            it("Should update pending trade", async function () {
                await buyTxBuilder();
                const takerTrade = await exchange.pendingTrades(addr1, TRANCHE_P, startEpoch);
                expect(takerTrade.takerBuy.frozenQuote).to.equal(matchedUsdc);
                expect(takerTrade.takerBuy.reservedBase).to.equal(matchedShares);
                const makerTrade = await exchange.pendingTrades(addr2, TRANCHE_P, startEpoch);
                expect(makerTrade.makerSell.frozenQuote).to.equal(matchedUsdc);
                expect(makerTrade.makerSell.reservedBase).to.equal(matchedShares);
            });

            it("Should emit event", async function () {
                await expect(buyTxBuilder())
                    .to.emit(exchange, "BuyTrade")
                    .withArgs(addr1, TRANCHE_P, matchedUsdc, 0, 41, 1, matchedShares);
            });

            it("Should keep the best ask level unchanged", async function () {
                await buyTxBuilder();
                expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(41);
            });
        });

        // USDC amount in the taker order literally equals to the amount of shares
        // in the best maker order. Estimated NAV is 0.9 and the maker order is completely filled.
        describe("A single maker is completely filled and the taker is partially filled", function () {
            const estimatedNav = parseEther("0.9");
            const matchedUsdc = ASK_1_PD_0.mul(estimatedNav)
                .div(parseEther("1"))
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const transferedUsdc = matchedUsdc.add(USDC_TO_ETHER).sub(1).div(USDC_TO_ETHER);
            const matchedShares = ASK_1_PD_0;
            const buyTxBuilder = () => exchange.buyP(0, 42, ASK_1_PD_0);

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
                const queue = await exchange.asks(0, TRANCHE_P, 41);
                expect(queue.head).to.equal(0);
                expect(queue.tail).to.equal(0);
                const order = await exchange.getAskOrder(0, TRANCHE_P, 41, 1);
                expect(order.maker).to.equal(ethers.constants.AddressZero);
                expect(order.amount).to.equal(0);
                expect(order.fillable).to.equal(0);
            });

            it("Should update pending trade", async function () {
                await buyTxBuilder();
                const takerTrade = await exchange.pendingTrades(addr1, TRANCHE_P, startEpoch);
                expect(takerTrade.takerBuy.frozenQuote).to.equal(matchedUsdc);
                expect(takerTrade.takerBuy.reservedBase).to.equal(matchedShares);
                const makerTrade = await exchange.pendingTrades(addr2, TRANCHE_P, startEpoch);
                expect(makerTrade.makerSell.frozenQuote).to.equal(matchedUsdc);
                expect(makerTrade.makerSell.reservedBase).to.equal(matchedShares);
            });

            it("Should emit event", async function () {
                await expect(buyTxBuilder())
                    .to.emit(exchange, "BuyTrade")
                    .withArgs(addr1, TRANCHE_P, matchedUsdc, 0, 43, 0, 0);
            });

            it("Should update the best ask level", async function () {
                await buyTxBuilder();
                expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(45);
            });
        });

        // Buy shares with 200 USDC at premium 2%. Estimated NAV is 1.
        // All orders at 0% and 1% are filled. The order at 2% is partially filled.
        describe("Fill orders at multiple premium-discount level", function () {
            const matchedUsdc = parseEther("200");
            const transferedUsdc = parseUsdc("200");
            const matchedUsdcAt0 = ASK_1_PD_0.mul(10000).div(MAKER_RESERVE_BPS);
            const matchedUsdcOrder1At1 = ASK_1_PD_1.mul(101)
                .div(100)
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const matchedUsdcOrder2At1 = ASK_2_PD_1.mul(101)
                .div(100)
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const matchedUsdcOrder3At1 = ASK_3_PD_1.mul(101)
                .div(100)
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const matchedUsdcAt1 = matchedUsdcOrder1At1
                .add(matchedUsdcOrder2At1)
                .add(matchedUsdcOrder3At1);
            const matchedUsdcAt2 = matchedUsdc.sub(matchedUsdcAt0).sub(matchedUsdcAt1);
            const matchedSharesAt2 = matchedUsdcAt2
                .mul(MAKER_RESERVE_BPS)
                .div(10000)
                .mul(100)
                .div(102);
            const buyTxBuilder = () => exchange.buyP(0, 49, matchedUsdc);

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
                const queueAt0 = await exchange.asks(0, TRANCHE_P, 41);
                expect(queueAt0.head).to.equal(0);
                expect(queueAt0.tail).to.equal(0);
                const queueAt1 = await exchange.asks(0, TRANCHE_P, 45);
                expect(queueAt1.head).to.equal(0);
                expect(queueAt1.tail).to.equal(0);
                const queueAt2 = await exchange.asks(0, TRANCHE_P, 49);
                expect(queueAt2.head).to.equal(1);
                expect(queueAt2.tail).to.equal(1);
                const order = await exchange.getAskOrder(0, TRANCHE_P, 49, 1);
                expect(order.fillable).to.equal(ASK_1_PD_2.sub(matchedSharesAt2));
            });

            it("Should update pending trade", async function () {
                await buyTxBuilder();
                const takerTrade = await exchange.pendingTrades(addr1, TRANCHE_P, startEpoch);
                expect(takerTrade.takerBuy.frozenQuote).to.equal(matchedUsdc);
                expect(takerTrade.takerBuy.reservedBase).to.equal(
                    ASK_1_PD_0.add(ASK_1_PD_1).add(ASK_2_PD_1).add(ASK_3_PD_1).add(matchedSharesAt2)
                );
                const maker2Trade = await exchange.pendingTrades(addr2, TRANCHE_P, startEpoch);
                expect(maker2Trade.makerSell.frozenQuote).to.equal(
                    matchedUsdcAt0.add(matchedUsdcOrder1At1).add(matchedUsdcOrder3At1)
                );
                expect(maker2Trade.makerSell.reservedBase).to.equal(
                    ASK_1_PD_0.add(ASK_1_PD_1).add(ASK_3_PD_1)
                );
                const maker3Trade = await exchange.pendingTrades(addr3, TRANCHE_P, startEpoch);
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
                    .withArgs(addr1, TRANCHE_P, matchedUsdc, 0, 49, 1, matchedSharesAt2);
            });

            it("Should update the best ask level", async function () {
                await buyTxBuilder();
                expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(49);
            });
        });

        // TODO skip expired maker, last order is skipped
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
                exchange.connect(user2).cancelAsk(0, TRANCHE_P, 41, 99)
            ).to.be.revertedWith("Maker address mismatched");
            await expect(
                exchange.connect(user2).cancelAsk(99, TRANCHE_P, 41, 1)
            ).to.be.revertedWith("Maker address mismatched");
        });

        it("Should revert when canceling other's order", async function () {
            await expect(exchange.cancelAsk(0, TRANCHE_P, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should revert when canceling completely filled order", async function () {
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.buyP(0, 42, ASK_1_PD_0);
            await expect(exchange.connect(user2).cancelAsk(0, TRANCHE_P, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should delete the canceled order", async function () {
            await exchange.connect(user2).cancelAsk(0, TRANCHE_P, 41, 1);
            const order = await exchange.getAskOrder(0, TRANCHE_P, 41, 1);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.fillable).to.equal(0);
        });

        it("Should update balance", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.buyP(0, 42, ASK_1_PD_0.div(2));
            const matchedShares = ASK_1_PD_0.div(2).mul(MAKER_RESERVE_BPS).div(10000);

            const oldAvailable = await exchange.availableBalanceOf(TRANCHE_P, addr2);
            await exchange.connect(user2).cancelAsk(0, TRANCHE_P, 41, 1);
            expect(await exchange.availableBalanceOf(TRANCHE_P, addr2)).to.equal(
                oldAvailable.add(ASK_1_PD_0).sub(matchedShares)
            );
        });

        it("Should emit event", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.buyP(0, 42, ASK_1_PD_0.div(2));
            const matchedUsdc = ASK_1_PD_0.div(2).mul(MAKER_RESERVE_BPS).div(10000);

            await expect(exchange.connect(user2).cancelAsk(0, TRANCHE_P, 41, 1))
                .to.emit(exchange, "AskOrderCanceled")
                .withArgs(addr2, TRANCHE_P, 41, ASK_1_PD_0, 0, 1, ASK_1_PD_0.sub(matchedUsdc));
        });

        it("Should update best ask", async function () {
            await exchange.connect(user2).cancelAsk(0, TRANCHE_P, 45, 1);
            expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(41);

            await exchange.connect(user2).cancelAsk(0, TRANCHE_P, 41, 1);
            expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(45);

            await exchange.connect(user3).cancelAsk(0, TRANCHE_P, 45, 2);
            expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(45);

            await exchange.connect(user2).cancelAsk(0, TRANCHE_P, 45, 3);
            expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(49);

            await exchange.connect(user3).cancelAsk(0, TRANCHE_P, 49, 1);
            expect(await exchange.bestAsks(0, TRANCHE_P)).to.equal(82);
        });
    });

    describe("sellP()", function () {
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
            await expect(exchange.sellP(0, 41, 1)).to.be.revertedWith("Exchange is inactive");
        });

        it("Should revert if price is not available", async function () {
            await twapOracle.mock.getTwap.returns(0);
            await expect(exchange.sellP(0, 41, 1)).to.be.revertedWith("Price is not available");
        });

        it("Should check pd level", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.sellP(0, 0, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
            await expect(exchange.sellP(0, 82, 1)).to.be.revertedWith(
                "Invalid premium-discount level"
            );
        });

        it("Should revert if no order can be matched", async function () {
            await fund.mock.extrapolateNav.returns(
                parseEther("1"),
                parseEther("1"),
                parseEther("1")
            );
            await expect(exchange.sellP(0, 42, 1)).to.be.revertedWith(
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
                .mul(MAKER_RESERVE_BPS)
                .div(10000)
                .mul(estimatedNav)
                .div(parseEther("1"));
            const sellTxBuilder = () => exchange.sellP(0, 33, matchedShares);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(estimatedNav, 0, 0);
            });

            it("Should update balance", async function () {
                await sellTxBuilder();
                expect(await exchange.availableBalanceOf(TRANCHE_P, addr1)).to.equal(
                    USER1_P.sub(matchedShares)
                );
            });

            it("Should update the maker order", async function () {
                await sellTxBuilder();
                const order = await exchange.getBidOrder(0, TRANCHE_P, 41, 1);
                expect(order.fillable).to.equal(BID_1_PD_0.sub(matchedUsdc));
            });

            it("Should update pending trade", async function () {
                await sellTxBuilder();
                const takerTrade = await exchange.pendingTrades(addr1, TRANCHE_P, startEpoch);
                expect(takerTrade.takerSell.frozenBase).to.equal(matchedShares);
                expect(takerTrade.takerSell.reservedQuote).to.equal(matchedUsdc);
                const makerTrade = await exchange.pendingTrades(addr2, TRANCHE_P, startEpoch);
                expect(makerTrade.makerBuy.frozenBase).to.equal(matchedShares);
                expect(makerTrade.makerBuy.reservedQuote).to.equal(matchedUsdc);
            });

            it("Should emit event", async function () {
                await expect(sellTxBuilder())
                    .to.emit(exchange, "SellTrade")
                    .withArgs(addr1, TRANCHE_P, matchedShares, 0, 41, 1, matchedUsdc);
            });

            it("Should keep the best bid level unchanged", async function () {
                await sellTxBuilder();
                expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(41);
            });
        });

        // Share amount in the taker order literally equals to the amount of USDC
        // in the best maker order. Estimated NAV is 1.1 and the maker order is completely filled.
        describe("A single maker is completely filled and the taker is partially filled", function () {
            const estimatedNav = parseEther("1.1");
            const matchedShares = BID_1_PD_0.mul(parseEther("1"))
                .div(estimatedNav)
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const matchedUsdc = BID_1_PD_0;
            const sellTxBuilder = () => exchange.sellP(0, 40, BID_1_PD_0);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(estimatedNav, 0, 0);
            });

            it("Should update balance", async function () {
                await sellTxBuilder();
                expect(await exchange.availableBalanceOf(TRANCHE_P, addr1)).to.equal(
                    USER1_P.sub(matchedShares)
                );
            });

            it("Should delete the maker order", async function () {
                await sellTxBuilder();
                const queue = await exchange.bids(0, TRANCHE_P, 41);
                expect(queue.head).to.equal(0);
                expect(queue.tail).to.equal(0);
                const order = await exchange.getBidOrder(0, TRANCHE_P, 41, 1);
                expect(order.maker).to.equal(ethers.constants.AddressZero);
                expect(order.amount).to.equal(0);
                expect(order.fillable).to.equal(0);
            });

            it("Should update pending trade", async function () {
                await sellTxBuilder();
                const takerTrade = await exchange.pendingTrades(addr1, TRANCHE_P, startEpoch);
                expect(takerTrade.takerSell.frozenBase).to.equal(matchedShares);
                expect(takerTrade.takerSell.reservedQuote).to.equal(matchedUsdc);
                const makerTrade = await exchange.pendingTrades(addr2, TRANCHE_P, startEpoch);
                expect(makerTrade.makerBuy.frozenBase).to.equal(matchedShares);
                expect(makerTrade.makerBuy.reservedQuote).to.equal(matchedUsdc);
            });

            it("Should emit event", async function () {
                await expect(sellTxBuilder())
                    .to.emit(exchange, "SellTrade")
                    .withArgs(addr1, TRANCHE_P, matchedShares, 0, 39, 0, 0);
            });

            it("Should update the best bid level", async function () {
                await sellTxBuilder();
                expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(37);
            });
        });

        // Sell 200 shares at discount -2%. Estimated NAV is 1.
        // All orders at 0% and -1% are filled. The order at -2% is partially filled.
        describe("Fill orders at multiple premium-discount level", function () {
            const matchedShares = parseEther("200");
            const matchedSharesAt0 = BID_1_PD_0.mul(10000).div(MAKER_RESERVE_BPS);
            const matchedSharesOrder1AtN1 = BID_1_PD_N1.mul(100)
                .div(99)
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const matchedSharesOrder2AtN1 = BID_2_PD_N1.mul(100)
                .div(99)
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const matchedSharesOrder3AtN1 = BID_3_PD_N1.mul(100)
                .div(99)
                .mul(10000)
                .div(MAKER_RESERVE_BPS);
            const matchedSharesAtN1 = matchedSharesOrder1AtN1
                .add(matchedSharesOrder2AtN1)
                .add(matchedSharesOrder3AtN1);
            const matchedSharesAtN2 = matchedShares.sub(matchedSharesAt0).sub(matchedSharesAtN1);
            const matchedUsdcAtN2 = matchedSharesAtN2
                .mul(MAKER_RESERVE_BPS)
                .div(10000)
                .mul(98)
                .div(100);
            const sellTxBuilder = () => exchange.sellP(0, 33, matchedShares);

            beforeEach(async function () {
                await fund.mock.extrapolateNav
                    .withArgs(startEpoch - EPOCH * 2, parseEther("1000"))
                    .returns(parseEther("1"), 0, 0);
            });

            it("Should update balance", async function () {
                await sellTxBuilder();
                expect(await exchange.availableBalanceOf(TRANCHE_P, addr1)).to.equal(
                    USER1_P.sub(matchedShares)
                );
            });

            it("Should update maker orders", async function () {
                await sellTxBuilder();
                const queueAt0 = await exchange.bids(0, TRANCHE_P, 41);
                expect(queueAt0.head).to.equal(0);
                expect(queueAt0.tail).to.equal(0);
                const queueAt1 = await exchange.bids(0, TRANCHE_P, 37);
                expect(queueAt1.head).to.equal(0);
                expect(queueAt1.tail).to.equal(0);
                const queueAt2 = await exchange.bids(0, TRANCHE_P, 33);
                expect(queueAt2.head).to.equal(1);
                expect(queueAt2.tail).to.equal(1);
                const order = await exchange.getBidOrder(0, TRANCHE_P, 33, 1);
                expect(order.fillable).to.equal(BID_1_PD_N2.sub(matchedUsdcAtN2));
            });

            it("Should update pending trade", async function () {
                await sellTxBuilder();
                const takerTrade = await exchange.pendingTrades(addr1, TRANCHE_P, startEpoch);
                expect(takerTrade.takerSell.frozenBase).to.equal(matchedShares);
                expect(takerTrade.takerSell.reservedQuote).to.equal(
                    BID_1_PD_0.add(BID_1_PD_N1)
                        .add(BID_2_PD_N1)
                        .add(BID_3_PD_N1)
                        .add(matchedUsdcAtN2)
                );
                const maker2Trade = await exchange.pendingTrades(addr2, TRANCHE_P, startEpoch);
                expect(maker2Trade.makerBuy.frozenBase).to.equal(
                    matchedSharesAt0.add(matchedSharesOrder2AtN1).add(matchedSharesOrder3AtN1)
                );
                expect(maker2Trade.makerBuy.reservedQuote).to.equal(
                    BID_1_PD_0.add(BID_2_PD_N1).add(BID_3_PD_N1)
                );
                const maker3Trade = await exchange.pendingTrades(addr3, TRANCHE_P, startEpoch);
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
                    .withArgs(addr1, TRANCHE_P, matchedShares, 0, 33, 1, matchedUsdcAtN2);
            });

            it("Should update the best bid level", async function () {
                await sellTxBuilder();
                expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(33);
            });
        });

        // TODO skip expired maker, last order is skipped
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
                exchange.connect(user2).cancelBid(0, TRANCHE_P, 41, 99)
            ).to.be.revertedWith("Maker address mismatched");
            await expect(
                exchange.connect(user2).cancelBid(99, TRANCHE_P, 41, 1)
            ).to.be.revertedWith("Maker address mismatched");
        });

        it("Should revert when canceling other's order", async function () {
            await expect(exchange.cancelBid(0, TRANCHE_P, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should revert when canceling completely filled order", async function () {
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.sellP(0, 40, BID_1_PD_0);
            await expect(exchange.connect(user2).cancelBid(0, TRANCHE_P, 41, 1)).to.be.revertedWith(
                "Maker address mismatched"
            );
        });

        it("Should delete the canceled order", async function () {
            await exchange.connect(user2).cancelBid(0, TRANCHE_P, 41, 1);
            const order = await exchange.getBidOrder(0, TRANCHE_P, 41, 1);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.fillable).to.equal(0);
        });

        it("Should update balance", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.sellP(0, 40, BID_1_PD_0.div(2));
            const matchedUsdc = BID_1_PD_0.div(2).mul(MAKER_RESERVE_BPS).div(10000);

            const returnedUsdc = BID_1_PD_0.sub(matchedUsdc).div(USDC_TO_ETHER);
            await expect(() =>
                exchange.connect(user2).cancelBid(0, TRANCHE_P, 41, 1)
            ).to.changeTokenBalances(usdc, [user2, exchange], [returnedUsdc, returnedUsdc.mul(-1)]);
        });

        it("Should emit event", async function () {
            // Partially fill the order
            await fund.mock.extrapolateNav.returns(parseEther("1"), 0, 0);
            await exchange.sellP(0, 40, BID_1_PD_0.div(2));
            const matchedUsdc = BID_1_PD_0.div(2).mul(MAKER_RESERVE_BPS).div(10000);

            await expect(exchange.connect(user2).cancelBid(0, TRANCHE_P, 41, 1))
                .to.emit(exchange, "BidOrderCanceled")
                .withArgs(addr2, TRANCHE_P, 41, BID_1_PD_0, 0, 1, BID_1_PD_0.sub(matchedUsdc));
        });

        it("Should update best bid", async function () {
            await exchange.connect(user2).cancelBid(0, TRANCHE_P, 37, 2);
            expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(41);

            await exchange.connect(user2).cancelBid(0, TRANCHE_P, 41, 1);
            expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(37);

            await exchange.connect(user3).cancelBid(0, TRANCHE_P, 37, 1);
            expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(37);

            await exchange.connect(user2).cancelBid(0, TRANCHE_P, 37, 3);
            expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(33);

            await exchange.connect(user3).cancelBid(0, TRANCHE_P, 33, 1);
            expect(await exchange.bestBids(0, TRANCHE_P)).to.equal(0);
        });
    });

    describe("settleMaker() and settleTaker()", function () {
        let outerFixture: Fixture<FixtureData>;
        const frozenUsdcForP = parseEther("1");
        const reservedP = frozenUsdcForP.mul(MAKER_RESERVE_BPS).div(10000).mul(10).div(11);
        const frozenUsdcForA = parseEther("2");
        const reservedA = frozenUsdcForA.mul(MAKER_RESERVE_BPS).div(10000).mul(10).div(11);
        const frozenB = parseEther("3");
        const reservedUsdcForB = frozenB.mul(MAKER_RESERVE_BPS).div(10000).mul(9).div(10);

        async function tradeFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            const u2 = f.wallets.user2;

            // Order book of all the three tranches
            // Ask:
            // +10%   20(user2)
            // Bid:
            // -10%   50(user2)
            await f.exchange.connect(u2).placeAsk(TRANCHE_P, 81, ASK_1_PD_1, 0, 0);
            await f.exchange.connect(u2).placeAsk(TRANCHE_A, 81, ASK_1_PD_1, 0, 0);
            await f.exchange.connect(u2).placeAsk(TRANCHE_B, 81, ASK_1_PD_1, 0, 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_P, 1, BID_1_PD_N1, 0, 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_A, 1, BID_1_PD_N1, 0, 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_B, 1, BID_1_PD_N1, 0, 0);

            await f.fund.mock.extrapolateNav
                .withArgs(f.startEpoch - EPOCH * 2, parseEther("1000"))
                .returns(parseEther("1"), parseEther("1"), parseEther("1"));
            // User 1 buys P and A and sells B
            await f.exchange.buyP(0, 81, frozenUsdcForP);
            await f.exchange.buyA(0, 81, frozenUsdcForA);
            await f.exchange.sellB(0, 1, frozenB);

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
            amountP: BigNumberish,
            amountA: BigNumberish,
            amountB: BigNumberish,
            usdcAmount: BigNumberish
        ) {
            const result = await exchange.connect(user).callStatic[settleFuncName](epoch);
            expect(result.sharesP).to.equal(amountP);
            expect(result.sharesA).to.equal(amountA);
            expect(result.sharesB).to.equal(amountB);
            expect(result.quoteAmount).to.equal(usdcAmount);

            const oldP = await exchange.availableBalanceOf(TRANCHE_P, user.address);
            const oldA = await exchange.availableBalanceOf(TRANCHE_A, user.address);
            const oldB = await exchange.availableBalanceOf(TRANCHE_B, user.address);
            await expect(() =>
                exchange.connect(user)[settleFuncName](epoch)
            ).to.changeTokenBalances(
                usdc,
                [user, exchange],
                [
                    result.quoteAmount.div(USDC_TO_ETHER),
                    result.quoteAmount.div(USDC_TO_ETHER).mul(-1),
                ]
            );
            expect(await exchange.availableBalanceOf(TRANCHE_P, user.address)).to.equal(
                oldP.add(result.sharesP)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_A, user.address)).to.equal(
                oldA.add(result.sharesA)
            );
            expect(await exchange.availableBalanceOf(TRANCHE_B, user.address)).to.equal(
                oldB.add(result.sharesB)
            );
        }

        it("Should revert if price is not available", async function () {
            await twapOracle.mock.getTwap.withArgs(startEpoch + EPOCH).returns(0);
            await expect(exchange.settleMaker(startEpoch)).to.be.revertedWith(
                "Price is not available"
            );
            await expect(exchange.settleTaker(startEpoch)).to.be.revertedWith(
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
                exchange.connect(user3).settleMaker(startEpoch - EPOCH)
            ).to.changeTokenBalance(usdc, user3, 0);
            expect(await exchange.availableBalanceOf(TRANCHE_P, addr3)).to.equal(USER3_P);
            expect(await exchange.availableBalanceOf(TRANCHE_A, addr3)).to.equal(USER3_A);
            expect(await exchange.availableBalanceOf(TRANCHE_B, addr3)).to.equal(USER3_B);
        });

        describe("Settle at exactly the estimated NAV", function () {
            const settledP = frozenUsdcForP.mul(10).div(11);
            const settledA = frozenUsdcForA.mul(10).div(11);
            const settledB = frozenB;
            const settledUsdcForP = frozenUsdcForP;
            const settledUsdcForA = frozenUsdcForA;
            const settledUsdcForB = frozenB.mul(9).div(10);

            beforeEach(async function () {
                await fund.mock.extrapolateNav.returns(
                    parseEther("1"),
                    parseEther("1"),
                    parseEther("1")
                );
            });

            it("SettleTaker()", async function () {
                await expectSettleResult(
                    "settleTaker",
                    user1,
                    startEpoch,
                    settledP,
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
                    reservedP.sub(settledP),
                    reservedA.sub(settledA),
                    settledB,
                    settledUsdcForP.add(settledUsdcForA).add(reservedUsdcForB).sub(settledUsdcForB)
                );
            });
        });

        describe("Settle at a high price", function () {
            const navP = parseEther("1.2");
            const navA = parseEther("1.05");
            const navB = parseEther("1.35");
            const settledP = frozenUsdcForP.mul(10).div(11).mul(parseEther("1")).div(navP);
            const settledA = frozenUsdcForA.mul(10).div(11).mul(parseEther("1")).div(navA);
            const settledB = reservedUsdcForB.mul(parseEther("1")).div(navB.mul(9).div(10));
            const settledUsdcForP = frozenUsdcForP;
            const settledUsdcForA = frozenUsdcForA;
            const settledUsdcForB = reservedUsdcForB;

            beforeEach(async function () {
                await fund.mock.extrapolateNav.returns(navP, navA, navB);
            });

            it("SettleTaker()", async function () {
                await expectSettleResult(
                    "settleTaker",
                    user1,
                    startEpoch,
                    settledP,
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
                    reservedP.sub(settledP),
                    reservedA.sub(settledA),
                    settledB,
                    settledUsdcForP.add(settledUsdcForA)
                );
            });
        });

        describe("Settle at a low price", function () {
            const navP = parseEther("0.8");
            const navA = parseEther("1.05");
            const navB = parseEther("0.55");
            const settledP = reservedP;
            const settledA = frozenUsdcForA.mul(parseEther("1")).div(navA).mul(10).div(11);
            const settledB = frozenB;
            const settledUsdcForP = reservedP.mul(navP).div(parseEther("1")).mul(11).div(10);
            const settledUsdcForA = frozenUsdcForA;
            const settledUsdcForB = frozenB.mul(navB).div(parseEther("1")).mul(9).div(10);

            beforeEach(async function () {
                await fund.mock.extrapolateNav.returns(navP, navA, navB);
            });

            it("SettleTaker()", async function () {
                await expectSettleResult(
                    "settleTaker",
                    user1,
                    startEpoch,
                    settledP,
                    settledA,
                    0,
                    settledUsdcForB.add(frozenUsdcForP).sub(settledUsdcForP)
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
                    settledUsdcForP.add(settledUsdcForA).add(reservedUsdcForB).sub(settledUsdcForB)
                );
            });
        });
    });

    describe("Expired ask order", function () {
        let outerFixture: Fixture<FixtureData>;
        const frozenUsdc = parseEther("0.1");
        const reservedB = frozenUsdc.mul(11).div(10);

        async function expiredAskOrderFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            const u2 = f.wallets.user2;
            const u3 = f.wallets.user3;
            await f.votingEscrow.mock.getTimestampDropBelow
                .withArgs(u3.address, MAKER_REQUIREMENT)
                .returns(f.startEpoch + EPOCH * 9.5);
            await f.exchange.connect(u3).applyForMaker();
            await f.exchange.connect(u3).placeAsk(TRANCHE_B, 41, parseEther("1"), 0, 0);
            await f.exchange.connect(u2).placeAsk(TRANCHE_B, 41, parseEther("1"), 0, 0);
            await f.exchange.connect(u3).placeAsk(TRANCHE_B, 41, parseEther("1"), 0, 0);
            await f.fund.mock.extrapolateNav.returns(0, 0, parseEther("1"));
            // Buy something before user3's orders expire
            advanceBlockAtTime(f.startEpoch + EPOCH * 9);
            await f.exchange.buyB(0, 41, frozenUsdc);
            // Buy something in the same epoch after user3's orders expire
            advanceBlockAtTime(f.startEpoch + EPOCH * 9.5);
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
            const user3Trade = await exchange.pendingTrades(
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
            const user3Trade = await exchange.pendingTrades(
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
            const user3Trade = await exchange.pendingTrades(
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
        const reservedUsdc = frozenA.mul(11).div(10);

        async function expiredBidOrderFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            const u2 = f.wallets.user2;
            const u3 = f.wallets.user3;
            await f.votingEscrow.mock.getTimestampDropBelow
                .withArgs(u3.address, MAKER_REQUIREMENT)
                .returns(f.startEpoch + EPOCH * 9.5);
            await f.exchange.connect(u3).applyForMaker();
            await f.exchange.connect(u3).placeBid(TRANCHE_A, 41, parseEther("1"), 0, 0);
            await f.exchange.connect(u2).placeBid(TRANCHE_A, 41, parseEther("1"), 0, 0);
            await f.exchange.connect(u3).placeBid(TRANCHE_A, 41, parseEther("1"), 0, 0);
            await f.fund.mock.extrapolateNav.returns(0, parseEther("1"), 0);
            // Sell something before user3's orders expire
            advanceBlockAtTime(f.startEpoch + EPOCH * 9);
            await f.exchange.sellA(0, 41, frozenA);
            // Sell something in the same epoch after user3's orders expire
            advanceBlockAtTime(f.startEpoch + EPOCH * 9.5);
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
            const user3Trade = await exchange.pendingTrades(
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
            const user3Trade = await exchange.pendingTrades(
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
            const user3Trade = await exchange.pendingTrades(
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
});
