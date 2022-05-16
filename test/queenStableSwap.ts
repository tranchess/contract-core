import { expect } from "chai";
import { BigNumber, BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import {
    TRANCHE_Q,
    DAY,
    WEEK,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";

const BTC_TO_ETHER = parseUnits("1", 10);
const UNIT = parseEther("1");
const AMPL = 80;
const FEE_RATE = parseEther("0.03");
const ADMIN_FEE_RATE = parseEther("0.4");

const INIT_Q = parseEther("100");
const INIT_BTC = parseBtc("200");
const INIT_LP = parseEther("400");

describe("QueenStableSwap", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly btc: Contract;
        readonly fund: MockContract;
        readonly tmpBase: MockContract;
        readonly lpToken: Contract;
        readonly stableSwap: Contract;
        readonly swapRouter: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let feeCollector: Wallet;
    let addr1: string;
    let addr2: string;
    let btc: Contract;
    let fund: MockContract;
    let tmpBase: MockContract;
    let lpToken: Contract;
    let stableSwap: Contract;
    let swapRouter: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector] = provider.getWallets();

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.tokenUnderlying.returns(btc.address);
        await fund.mock.underlyingDecimalMultiplier.returns(parseUnits("1", 10));
        // Set oracle price to 2
        await fund.mock.getTotalUnderlying.returns(parseBtc("2000"));
        await fund.mock.getEquivalentTotalQ.returns(parseEther("1000"));

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        await chessSchedule.mock.getRate.returns(UNIT);
        const chessController = await deployMockForName(owner, "ChessController");
        await chessController.mock.getFundRelativeWeight.returns(UNIT);
        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(1);
        const rewardToken = await MockToken.connect(owner).deploy("Temporary Token", "TMP", 8);
        const swapReward = await deployMockForName(owner, "SwapReward");
        await swapReward.mock.rewardToken.returns(rewardToken.address);
        await swapReward.mock.getReward.returns();

        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const lpToken = await LiquidityGauge.connect(owner).deploy(
            "pool2 token",
            "pool2 token",
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address,
            swapReward.address
        );

        const StableSwap = await ethers.getContractFactory("QueenStableSwap");
        const stableSwap = await StableSwap.connect(owner).deploy(
            lpToken.address,
            fund.address,
            8,
            AMPL,
            feeCollector.address,
            FEE_RATE,
            ADMIN_FEE_RATE
        );
        await lpToken.transferOwnership(stableSwap.address);

        const tmpBase = await deployMockForName(owner, "ERC20");
        await fund.mock.tokenShare.withArgs(TRANCHE_Q).returns(tmpBase.address);

        // Add initial liquidity
        await tmpBase.mock.balanceOf.withArgs(stableSwap.address).returns(INIT_Q);
        await btc.mint(stableSwap.address, INIT_BTC);
        await stableSwap.addLiquidity(0, user1.address);

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();
        await swapRouter.addSwap(tmpBase.address, btc.address, stableSwap.address);

        return {
            wallets: { user1, user2, owner, feeCollector },
            btc,
            fund,
            tmpBase,
            lpToken,
            stableSwap: stableSwap.connect(user1),
            swapRouter: swapRouter.connect(user1),
        };
    }

    async function setOraclePrice(p: BigNumberish): Promise<void> {
        await fund.mock.getTotalUnderlying.returns(parseBtc("1000").mul(p).div(UNIT));
    }

    async function addBase(amount: BigNumberish): Promise<void> {
        const oldBase = await tmpBase.balanceOf(stableSwap.address);
        await tmpBase.mock.balanceOf.withArgs(stableSwap.address).returns(oldBase.add(amount));
    }

    async function addQuote(amount: BigNumberish): Promise<void> {
        await btc.mint(stableSwap.address, amount);
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        owner = fixtureData.wallets.owner;
        feeCollector = fixtureData.wallets.feeCollector;
        addr1 = user1.address;
        addr2 = user2.address;
        btc = fixtureData.btc;
        fund = fixtureData.fund;
        tmpBase = fixtureData.tmpBase;
        lpToken = fixtureData.lpToken;
        stableSwap = fixtureData.stableSwap;
        swapRouter = fixtureData.swapRouter;
    });

    describe("Price and slippage", function () {
        function testGetPrice(price: BigNumber): () => Promise<void> {
            return async function () {
                const priceOverOracle = price.div(2); // oracle price is 2
                expect(await stableSwap.getCurrentPriceOverOracle()).to.be.closeTo(
                    priceOverOracle,
                    priceOverOracle.div(10000)
                );
                expect(await stableSwap.getCurrentPrice()).to.be.closeTo(price, price.div(10000));

                await addQuote((await btc.balanceOf(stableSwap.address)).mul(2)); // Triple quote balance
                await stableSwap.sync();
                await setOraclePrice(parseEther("6")); // Triple oracle price
                expect(await stableSwap.getCurrentPriceOverOracle()).to.be.closeTo(
                    priceOverOracle,
                    priceOverOracle.div(10000)
                );
                expect(await stableSwap.getCurrentPrice()).to.be.closeTo(
                    price.mul(3),
                    price.mul(3).div(10000)
                );
            };
        }

        function testGetBaseOut(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const inBtc = INIT_BTC.div(1000);
                const outQ = await stableSwap.getBaseOut(inBtc);
                const fee = inBtc.mul(FEE_RATE).div(UNIT);
                const swapPrice = inBtc.sub(fee).mul(BTC_TO_ETHER).mul(UNIT).div(outQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addQuote(inBtc);
                await stableSwap.buy(0, outQ, addr1, "0x");
            };
        }

        function testGetQuoteIn(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const outQ = INIT_Q.div(1000);
                const inBtc = await stableSwap.getQuoteIn(outQ);
                const fee = inBtc.mul(FEE_RATE).div(UNIT);
                const swapPrice = inBtc.sub(fee).mul(BTC_TO_ETHER).mul(UNIT).div(outQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addQuote(inBtc);
                await stableSwap.buy(0, outQ, addr1, "0x");
            };
        }

        function testGetQuoteOut(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const inQ = INIT_Q.div(1000);
                const outBtc = await stableSwap.getQuoteOut(inQ);
                const fee = outBtc.mul(FEE_RATE).div(UNIT.sub(FEE_RATE));
                const swapPrice = outBtc.add(fee).mul(BTC_TO_ETHER).mul(UNIT).div(inQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addBase(inQ);
                await stableSwap.sell(0, outBtc, addr1, "0x");
            };
        }

        function testGetBaseIn(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const outBtc = INIT_BTC.div(1000);
                const inQ = await stableSwap.getBaseIn(outBtc);
                const fee = outBtc.mul(FEE_RATE).div(UNIT.sub(FEE_RATE));
                const swapPrice = outBtc.add(fee).mul(BTC_TO_ETHER).mul(UNIT).div(inQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addBase(inQ);
                await stableSwap.sell(0, outBtc, addr1, "0x");
            };
        }

        function testAddBase(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const inBtc = INIT_BTC.div(1000);
                // Estimate LP token amount and fee (slippage ignored)
                const oldBtc = await btc.balanceOf(stableSwap.address);
                const oldQ = await tmpBase.balanceOf(stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldBtc.mul(BTC_TO_ETHER));
                const newValue = oldValue.add(inBtc.mul(BTC_TO_ETHER));
                const swappedBtc = inBtc.sub(oldBtc.mul(newValue.sub(oldValue)).div(oldValue));
                const fee = swappedBtc.mul(FEE_RATE).div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const lp = inBtc.sub(fee).mul(BTC_TO_ETHER).mul(INIT_LP).div(oldValue);
                // Check the estimation
                await addQuote(inBtc);
                await stableSwap.addLiquidity(0, addr2);
                expect(await stableSwap.totalAdminFee()).to.be.closeTo(
                    adminFee,
                    adminFee.mul(slippageBps).div(10000)
                );
                expect(await lpToken.balanceOf(addr2)).to.be.closeTo(
                    lp,
                    lp.mul(slippageBps).div(10000)
                );
            };
        }

        function testAddQuote(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const inQ = INIT_Q.div(1000);
                // Estimate LP token amount and fee (slippage ignored)
                const oldBtc = await btc.balanceOf(stableSwap.address);
                const oldQ = await tmpBase.balanceOf(stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldBtc.mul(BTC_TO_ETHER));
                const newValue = oldValue.add(inQ.mul(price).div(UNIT));
                const swappedBtc = oldBtc.mul(newValue.sub(oldValue)).div(oldValue);
                const fee = swappedBtc.mul(FEE_RATE).div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const lp = newValue
                    .sub(fee.mul(BTC_TO_ETHER))
                    .sub(oldValue)
                    .mul(INIT_LP)
                    .div(oldValue);
                // Check the estimation
                await addBase(inQ);
                await stableSwap.addLiquidity(0, addr2);
                expect(await stableSwap.totalAdminFee()).to.be.closeTo(
                    adminFee,
                    adminFee.mul(slippageBps).div(10000)
                );
                expect(await lpToken.balanceOf(addr2)).to.be.closeTo(
                    lp,
                    lp.mul(slippageBps).div(10000)
                );
            };
        }

        function testRemoveBase(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const inLp = INIT_LP.div(10000);
                // Estimate output amount and fee (slippage ignored)
                const oldBtc = await btc.balanceOf(stableSwap.address);
                const oldQ = await tmpBase.balanceOf(stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldBtc.mul(BTC_TO_ETHER));
                const removedValue = oldValue.div(10000);
                const fee = oldBtc.div(10000).mul(FEE_RATE).div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const outQ = removedValue.sub(fee.mul(BTC_TO_ETHER)).mul(UNIT).div(price);
                // Check the estimation
                expect(await stableSwap.callStatic.removeBaseLiquidity(0, inLp, 0)).to.be.closeTo(
                    outQ,
                    outQ.mul(slippageBps).div(10000)
                );
                await stableSwap.removeBaseLiquidity(0, inLp, 0);
                expect(await stableSwap.totalAdminFee()).to.be.closeTo(
                    adminFee,
                    adminFee.mul(slippageBps).div(10000)
                );
            };
        }

        function testRemoveQuote(price: BigNumber, slippageBps: number): () => Promise<void> {
            return async function () {
                const inLp = INIT_LP.div(10000);
                // Estimate output amount and fee (slippage ignored)
                const oldBtc = await btc.balanceOf(stableSwap.address);
                const oldQ = await tmpBase.balanceOf(stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldBtc.mul(BTC_TO_ETHER));
                const removedValue = oldValue.div(10000);
                const fee = oldQ
                    .div(10000)
                    .mul(price)
                    .div(UNIT)
                    .div(BTC_TO_ETHER)
                    .mul(FEE_RATE)
                    .div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const outBtc = removedValue.div(BTC_TO_ETHER).sub(fee);
                // Check the estimation
                expect(await stableSwap.callStatic.removeQuoteLiquidity(0, inLp, 0)).to.be.closeTo(
                    outBtc,
                    outBtc.mul(slippageBps).div(10000)
                );
                await stableSwap.removeQuoteLiquidity(0, inLp, 0);
                expect(await stableSwap.totalAdminFee()).to.be.closeTo(
                    adminFee,
                    adminFee.mul(slippageBps).div(10000)
                );
            };
        }

        beforeEach(async function () {
            // Base token transfer is tested in other cases. This section focuses on price.
            await tmpBase.mock.transfer.returns(true);
        });

        describe("Balanced pool", function () {
            const PRICE = parseEther("2");

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1));
            it("Add base tokens", testAddBase(PRICE, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 1));
        });

        describe("10 bps premium at base:quote=1:1.174 (Ampl=80)", function () {
            const PRICE = parseEther("2.002");

            beforeEach(async function () {
                await addQuote(INIT_BTC.mul(174).div(1000));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1));
            it("Add base tokens", testAddBase(PRICE, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 1));
        });

        describe("10 bps discount at base:quote=1.174:1 (Ampl=80)", function () {
            const PRICE = parseEther("1.998");

            beforeEach(async function () {
                await addBase(INIT_Q.mul(174).div(1000));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1));
            it("Add base tokens", testAddBase(PRICE, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 1));
        });

        describe("1% premium at base:quote=1:2.85 (Ampl=80)", async function () {
            const PRICE = parseEther("2.02");

            beforeEach(async function () {
                await addQuote(INIT_BTC.mul(185).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1));
            it("Add base tokens", testAddBase(PRICE, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 1));
        });

        describe("1% discount at base:quote=2.85:1 (Ampl=80)", function () {
            const PRICE = parseEther("1.98");

            beforeEach(async function () {
                await addBase(INIT_Q.mul(185).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1));
            it("Add base tokens", testAddBase(PRICE, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 1));
        });

        describe("100x price at base:quote=1:560.24 (Ampl=80)", async function () {
            const PRICE = parseEther("200");

            beforeEach(async function () {
                await addQuote(INIT_BTC.mul(55924).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 10));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 10));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 10));
            it("getBaseIn()", testGetBaseIn(PRICE, 10));
            it("Add base tokens", testAddBase(PRICE, 10));
            it("Add quote tokens", testAddQuote(PRICE, 10));
            it("Remove base tokens", testRemoveBase(PRICE, 10));
            it("Remove quote tokens", testRemoveQuote(PRICE, 10));
        });

        describe("1/100 price at base:quote=560.24:1 (Ampl=80)", async function () {
            const PRICE = parseEther("0.02");

            beforeEach(async function () {
                await addBase(INIT_Q.mul(55924).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 10));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 10));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 10));
            it("getBaseIn()", testGetBaseIn(PRICE, 10));
            it("Add base tokens", testAddBase(PRICE, 10));
            it("Add quote tokens", testAddQuote(PRICE, 10));
            it("Remove base tokens", testRemoveBase(PRICE, 10));
            it("Remove quote tokens", testRemoveQuote(PRICE, 10));
        });
    });

    describe("buy()", function () {
        let inBtc: BigNumber;
        let outQ: BigNumber;
        let fee: BigNumber;
        let adminFee: BigNumber;

        this.beforeEach(async function () {
            inBtc = INIT_BTC.div(1000);
            outQ = await stableSwap.getBaseOut(inBtc);
            fee = inBtc.mul(FEE_RATE).div(UNIT);
            adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
        });

        it("Should revert if output is zero", async function () {
            await expect(stableSwap.buy(0, 0, addr1, "0x")).to.be.revertedWith("Zero output");
        });

        it("Should revert if output exceeds liquidity", async function () {
            await expect(stableSwap.buy(0, INIT_Q, addr1, "0x")).to.be.revertedWith(
                "Insufficient liquidity"
            );
        });

        it("Should revert if input is not sufficient", async function () {
            await addQuote(inBtc.mul(9).div(10));
            await tmpBase.mock.transfer.returns(true);
            await expect(stableSwap.buy(0, outQ, addr1, "0x")).to.be.revertedWith(
                "Invariant mismatch"
            );
        });

        it("Should transfer base token to recipient", async function () {
            await addQuote(inBtc);
            await expect(() => stableSwap.buy(0, outQ, addr2, "0x")).to.callMocks({
                func: tmpBase.mock.transfer.withArgs(addr2, outQ),
                rets: [true],
            });
        });

        it("Should update stored balance and admin fee", async function () {
            await addQuote(inBtc);
            await tmpBase.mock.transfer.returns(true);
            await stableSwap.buy(0, outQ, addr2, "0x");
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q.sub(outQ));
            expect(quote).to.equal(INIT_BTC.add(inBtc).sub(adminFee));
            expect(await stableSwap.totalAdminFee()).to.equal(adminFee);
        });

        it("Should emit an event", async function () {
            await addQuote(inBtc);
            await tmpBase.mock.transfer.returns(true);
            await expect(stableSwap.buy(0, outQ, addr2, "0x"))
                .to.emit(stableSwap, "Swap")
                .withArgs(addr1, addr2, 0, inBtc, outQ, 0, fee, adminFee, parseEther("2"));
        });
    });

    describe("sell()", function () {
        let inQ: BigNumber;
        let outBtc: BigNumber;
        let fee: BigNumber;
        let adminFee: BigNumber;

        this.beforeEach(async function () {
            inQ = INIT_Q.div(1000);
            outBtc = await stableSwap.getQuoteOut(inQ);
            fee = outBtc.mul(FEE_RATE).div(UNIT.sub(FEE_RATE));
            adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
        });

        it("Should revert if output is zero", async function () {
            await expect(stableSwap.sell(0, 0, addr1, "0x")).to.be.revertedWith("Zero output");
        });

        it("Should revert if output exceeds liquidity", async function () {
            await expect(stableSwap.sell(0, INIT_BTC, addr1, "0x")).to.be.revertedWith(
                "Insufficient liquidity"
            );
        });

        it("Should revert if input is not sufficient", async function () {
            await addBase(inQ.mul(9).div(10));
            await expect(stableSwap.sell(0, outBtc, addr1, "0x")).to.be.revertedWith(
                "Invariant mismatch"
            );
        });

        it("Should transfer quote token to recipient", async function () {
            await addBase(inQ);
            await expect(() => stableSwap.sell(0, outBtc, addr2, "0x")).to.changeTokenBalances(
                btc,
                [user2, stableSwap],
                [outBtc, outBtc.mul(-1)]
            );
        });

        it("Should update stored balance and admin fee", async function () {
            await addBase(inQ);
            await stableSwap.sell(0, outBtc, addr2, "0x");
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q.add(inQ));
            expect(quote).to.equal(INIT_BTC.sub(outBtc).sub(adminFee));
            expect(await stableSwap.totalAdminFee()).to.equal(adminFee);
        });

        it("Should emit an event", async function () {
            await addBase(inQ);
            await tmpBase.mock.transfer.returns(true);
            await expect(stableSwap.sell(0, outBtc, addr2, "0x"))
                .to.emit(stableSwap, "Swap")
                .withArgs(addr1, addr2, inQ, 0, 0, outBtc, fee, adminFee, parseEther("2"));
        });
    });

    describe("addLiquidity()", function () {
        it("Should mint initial LP tokens", async function () {
            expect(await lpToken.totalSupply()).to.equal(INIT_LP);
            expect(await lpToken.balanceOf(addr1)).to.equal(INIT_LP);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q);
            expect(quote).to.equal(INIT_BTC);
        });

        it("Should revert if no liquidity is added", async function () {
            await expect(stableSwap.addLiquidity(0, addr1)).to.be.revertedWith(
                "No liquidity is added"
            );
        });

        it("Should mint LP tokens proportionally", async function () {
            await addBase(INIT_Q.div(2));
            await addQuote(INIT_BTC.div(2));
            await stableSwap.addLiquidity(0, addr2);
            expect(await lpToken.balanceOf(addr2)).to.equal(INIT_LP.div(2));
        });

        it("Should return minted amount", async function () {
            await addBase(INIT_Q.div(2));
            await addQuote(INIT_BTC.div(2));
            expect(await stableSwap.callStatic.addLiquidity(0, addr1)).to.equal(INIT_LP.div(2));
        });

        it("Should update stored balance", async function () {
            await addBase(INIT_Q.div(2));
            await addQuote(INIT_BTC.div(2));
            await stableSwap.addLiquidity(0, addr2);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q.mul(3).div(2));
            expect(quote).to.equal(INIT_BTC.mul(3).div(2));
        });

        it("Should emit an event", async function () {
            await addBase(INIT_Q.div(2));
            await addQuote(INIT_BTC.div(2));
            await expect(stableSwap.addLiquidity(0, addr2))
                .to.emit(stableSwap, "LiquidityAdded")
                .withArgs(
                    addr1,
                    addr2,
                    INIT_Q.div(2),
                    INIT_BTC.div(2),
                    INIT_LP.div(2),
                    0,
                    0,
                    parseEther("2")
                );
        });
    });

    describe("removeLiquidity()", function () {
        it("Should burn LP tokens", async function () {
            await tmpBase.mock.transfer.returns(true);
            await expect(() =>
                stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0)
            ).to.changeTokenBalance(lpToken, user1, INIT_LP.div(-10));
        });

        it("Should transfer base tokens", async function () {
            await expect(() => stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0)).to.callMocks({
                func: tmpBase.mock.transfer.withArgs(addr1, INIT_Q.div(10)),
                rets: [true],
            });
        });

        it("Should transfer quote tokens", async function () {
            await tmpBase.mock.transfer.returns(true);
            await expect(() =>
                stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0)
            ).to.changeTokenBalances(
                btc,
                [user1, stableSwap],
                [INIT_BTC.div(10), INIT_BTC.div(-10)]
            );
        });

        it("Should return base and quote amount", async function () {
            await tmpBase.mock.transfer.returns(true);
            const ret = await stableSwap.callStatic.removeLiquidity(0, INIT_LP.div(10), 0, 0);
            expect(ret.baseOut).to.equal(INIT_Q.div(10));
            expect(ret.quoteOut).to.equal(INIT_BTC.div(10));
        });

        it("Should check min output", async function () {
            await tmpBase.mock.transfer.returns(true);
            await expect(
                stableSwap.removeLiquidity(0, INIT_LP.div(10), INIT_Q.div(10).add(1), 0)
            ).to.be.revertedWith("Insufficient output");
            await expect(
                stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, INIT_BTC.div(10).add(1))
            ).to.be.revertedWith("Insufficient output");
            await stableSwap.removeLiquidity(0, INIT_LP.div(10), INIT_Q.div(10), INIT_BTC.div(10));
        });

        it("Should update stored balance", async function () {
            await tmpBase.mock.transfer.returns(true);
            await stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q.mul(9).div(10));
            expect(quote).to.equal(INIT_BTC.mul(9).div(10));
        });

        it("Should emit an event", async function () {
            await tmpBase.mock.transfer.returns(true);
            await expect(stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0))
                .to.emit(stableSwap, "LiquidityRemoved")
                .withArgs(addr1, INIT_LP.div(10), INIT_Q.div(10), INIT_BTC.div(10), 0, 0, 0);
        });
    });

    describe("removeBaseLiquidity()", function () {
        let inLp: BigNumber;
        let outQ: BigNumber;

        this.beforeEach(async function () {
            inLp = INIT_LP.div(1000);
            await tmpBase.mock.transfer.returns(true);
            outQ = await stableSwap.callStatic.removeBaseLiquidity(0, inLp, 0);
        });

        it("Should burn LP tokens", async function () {
            await expect(() => stableSwap.removeBaseLiquidity(0, inLp, 0)).to.changeTokenBalance(
                lpToken,
                user1,
                inLp.mul(-1)
            );
        });

        it("Should transfer base tokens", async function () {
            await expect(() => stableSwap.removeBaseLiquidity(0, inLp, 0)).to.callMocks({
                func: tmpBase.mock.transfer.withArgs(addr1, outQ),
                rets: [true],
            });
        });

        it("Should check min output", async function () {
            await expect(stableSwap.removeBaseLiquidity(0, inLp, outQ.add(1))).to.be.revertedWith(
                "Insufficient output"
            );
            await stableSwap.removeBaseLiquidity(0, inLp, outQ);
        });

        it("Should update stored balance", async function () {
            await stableSwap.removeBaseLiquidity(0, inLp, 0);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q.sub(outQ));
            expect(quote).to.equal(INIT_BTC.sub(await stableSwap.totalAdminFee()));
        });

        it("Should emit an event", async function () {
            await expect(stableSwap.removeBaseLiquidity(0, inLp, 0)).to.emit(
                stableSwap,
                "LiquidityRemoved"
            );
        });
    });

    describe("removeQuoteLiquidity()", function () {
        let inLp: BigNumber;
        let outBtc: BigNumber;

        this.beforeEach(async function () {
            inLp = INIT_LP.div(1000);
            outBtc = await stableSwap.callStatic.removeQuoteLiquidity(0, inLp, 0);
        });

        it("Should burn LP tokens", async function () {
            await expect(() => stableSwap.removeQuoteLiquidity(0, inLp, 0)).to.changeTokenBalance(
                lpToken,
                user1,
                inLp.mul(-1)
            );
        });

        it("Should transfer quote tokens", async function () {
            await expect(() => stableSwap.removeQuoteLiquidity(0, inLp, 0)).to.changeTokenBalances(
                btc,
                [user1, stableSwap],
                [outBtc, outBtc.mul(-1)]
            );
        });

        it("Should check min output", async function () {
            await expect(
                stableSwap.removeQuoteLiquidity(0, inLp, outBtc.add(1))
            ).to.be.revertedWith("Insufficient output");
            await stableSwap.removeQuoteLiquidity(0, inLp, outBtc);
        });

        it("Should update stored balance", async function () {
            await stableSwap.removeQuoteLiquidity(0, inLp, 0);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q);
            expect(quote).to.equal(INIT_BTC.sub(outBtc).sub(await stableSwap.totalAdminFee()));
        });

        it("Should emit an event", async function () {
            await expect(stableSwap.removeQuoteLiquidity(0, inLp, 0)).to.emit(
                stableSwap,
                "LiquidityRemoved"
            );
        });
    });

    describe("sync()", function () {
        it("Should update stored balance", async function () {
            await addBase(parseEther("0.123"));
            await addQuote(parseEther("0.456"));
            await stableSwap.sync();
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_Q.add(parseEther("0.123")));
            expect(quote).to.equal(INIT_BTC.add(parseEther("0.456")));
        });

        it("Should emit an event", async function () {
            await addBase(parseEther("0.123"));
            await addQuote(parseEther("0.456"));
            await expect(stableSwap.sync())
                .to.emit(stableSwap, "Sync")
                .withArgs(
                    INIT_Q.add(parseEther("0.123")),
                    INIT_BTC.add(parseEther("0.456")),
                    parseEther("2")
                );
        });
    });

    describe("Empty pool", function () {
        beforeEach(async function () {
            await tmpBase.mock.transfer.returns(true);
            await stableSwap.removeLiquidity(0, INIT_LP, 0, 0);
            // Mock the transfer in removeLiquidity
            await tmpBase.mock.balanceOf.withArgs(stableSwap.address).returns(0);
        });

        it("getCurrentPriceOverOracle() and getCurrentPrice()", async function () {
            expect(await stableSwap.getCurrentPriceOverOracle()).to.equal(UNIT);
            expect(await stableSwap.getCurrentPrice()).to.equal(parseEther("2"));
        });

        it("Should require both assets for initial liquidity", async function () {
            await tmpBase.mock.balanceOf.withArgs(stableSwap.address).returns(INIT_Q);
            await expect(stableSwap.addLiquidity(0, addr1)).to.be.revertedWith(
                "Zero initial balance"
            );

            await tmpBase.mock.balanceOf.withArgs(stableSwap.address).returns(0);
            await btc.mint(stableSwap.address, INIT_BTC);
            await expect(stableSwap.addLiquidity(0, addr1)).to.be.revertedWith(
                "Zero initial balance"
            );
        });
    });

    describe("getPriceOverOracleIntegral()", function () {
        let startTimestamp: number;
        let startIntegral: BigNumber;

        async function testIntegralUpdate(operation: Promise<void>): Promise<void> {
            await setNextBlockTime(startTimestamp + 100);
            await operation;
            const newPriceOverOracle = await stableSwap.getCurrentPriceOverOracle();
            expect(newPriceOverOracle).to.not.equal(UNIT);
            await advanceBlockAtTime(startTimestamp + 300);
            expect(await stableSwap.getPriceOverOracleIntegral()).to.equal(
                startIntegral.add(UNIT.mul(100)).add(newPriceOverOracle.mul(200))
            );
        }

        beforeEach(async function () {
            await tmpBase.mock.transfer.returns(true);
            startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
            startIntegral = await stableSwap.getPriceOverOracleIntegral();
        });

        it("Should accumulate the value of price over oracle", async function () {
            await advanceBlockAtTime(startTimestamp + 100);
            expect(await stableSwap.getPriceOverOracleIntegral()).to.equal(
                startIntegral.add(UNIT.mul(100))
            );
        });

        it("Should update integral in buy()", async function () {
            const inBtc = INIT_BTC.div(10);
            const outQ = await stableSwap.getBaseOut(inBtc);
            await addQuote(inBtc);
            await testIntegralUpdate(stableSwap.buy(0, outQ, addr1, "0x"));
        });

        it("Should update integral in sell()", async function () {
            const inQ = INIT_Q.div(10);
            const outBtc = await stableSwap.getQuoteOut(inQ);
            await addBase(inQ);
            await testIntegralUpdate(stableSwap.sell(0, outBtc, addr1, "0x"));
        });

        it("Should update integral in addLiquidity()", async function () {
            await addBase(INIT_Q.div(10));
            await testIntegralUpdate(stableSwap.addLiquidity(0, addr2));
        });

        it("Should update integral in removeBaseLiquidity()", async function () {
            await testIntegralUpdate(stableSwap.removeBaseLiquidity(0, INIT_LP.div(10), 0));
        });

        it("Should update integral in removeQuoteLiquidity()", async function () {
            await testIntegralUpdate(stableSwap.removeQuoteLiquidity(0, INIT_LP.div(10), 0));
        });

        it("Should update integral in sync()", async function () {
            await addBase(INIT_Q.div(10));
            await testIntegralUpdate(stableSwap.sync());
        });

        it("Should update integral when the pool is empty", async function () {
            await addBase(INIT_Q.div(10));
            await setNextBlockTime(startTimestamp + 100);
            await stableSwap.sync();

            await setNextBlockTime(startTimestamp + 300);
            await stableSwap.removeLiquidity(0, INIT_LP, 0, 0);
            // Mock the transfer in removeLiquidity
            await tmpBase.mock.balanceOf.withArgs(stableSwap.address).returns(0);

            // The following removeLiquidity() does not update the integral. So, the value of
            // price over oracle after sync() is not accumulated.
            await advanceBlockAtTime(startTimestamp + 600);
            expect(await stableSwap.getPriceOverOracleIntegral()).to.equal(
                startIntegral.add(UNIT.mul(600))
            );

            await addBase(INIT_Q);
            await addQuote(INIT_BTC.mul(2));
            await setNextBlockTime(startTimestamp + 1000);
            await stableSwap.addLiquidity(0, addr1);
            // Effective from t=1000 to t=1500
            const priceOverOracle2 = await stableSwap.getCurrentPriceOverOracle();

            await advanceBlockAtTime(startTimestamp + 1500);
            expect(await stableSwap.getPriceOverOracleIntegral()).to.equal(
                startIntegral.add(UNIT.mul(1000)).add(priceOverOracle2.mul(500))
            );
        });
    });

    describe("collectFee()", function () {
        it("Should transfer admin fee", async function () {
            await addBase(INIT_Q.div(100));
            await stableSwap.addLiquidity(0, addr2);
            await stableSwap.removeQuoteLiquidity(0, INIT_LP.div(100), 0);
            const adminFee = await stableSwap.totalAdminFee();
            expect(adminFee).to.gt(0);
            await expect(() => stableSwap.collectFee()).to.changeTokenBalances(
                btc,
                [feeCollector, stableSwap],
                [adminFee, adminFee.mul(-1)]
            );
            expect(await stableSwap.totalAdminFee()).to.equal(0);
        });
    });

    describe("updateAmplRamp()", function () {
        let startTimestamp: number;

        beforeEach(async function () {
            startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
            startTimestamp += 100;
            await setNextBlockTime(startTimestamp);
            stableSwap = stableSwap.connect(owner);
        });

        it("Should only be called by owner", async function () {
            await expect(
                stableSwap.connect(user1).updateAmplRamp(AMPL, startTimestamp + WEEK)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should revert if ampl is zero or too large", async function () {
            await expect(stableSwap.updateAmplRamp(0, startTimestamp + WEEK)).to.be.revertedWith(
                "Invalid A"
            );
            await expect(stableSwap.updateAmplRamp(1e8, startTimestamp + WEEK)).to.be.revertedWith(
                "Invalid A"
            );
        });

        it("Should revert if ramp time is too short", async function () {
            await expect(
                stableSwap.updateAmplRamp(AMPL, startTimestamp + DAY - 1)
            ).to.be.revertedWith("A ramp time too short");
        });

        it("Should revert if ampl is changed too much", async function () {
            await expect(
                stableSwap.updateAmplRamp(Math.ceil(AMPL / 10) - 1, startTimestamp + WEEK)
            ).to.be.revertedWith("A ramp change too large");
            await expect(
                stableSwap.updateAmplRamp(AMPL * 10 + 1, startTimestamp + WEEK)
            ).to.be.revertedWith("A ramp change too large");
        });

        it("Should update ampl", async function () {
            await stableSwap.updateAmplRamp(AMPL * 2, startTimestamp + DAY);
            await advanceBlockAtTime(startTimestamp + DAY / 3);
            expect(await stableSwap.getAmpl()).to.equal(Math.floor((AMPL * 4) / 3));

            // Update again before the last update completes (AMPL * 1.5 -> AMPL * 0.5)
            await setNextBlockTime(startTimestamp + DAY / 2);
            await stableSwap.updateAmplRamp(Math.floor(AMPL / 2), startTimestamp + DAY / 2 + WEEK);
            expect(await stableSwap.amplRampStart()).to.equal(Math.floor(AMPL * 1.5));

            await advanceBlockAtTime(startTimestamp + DAY / 2 + WEEK / 4);
            expect(await stableSwap.getAmpl()).to.equal(Math.floor(AMPL * 1.25));
            await advanceBlockAtTime(startTimestamp + DAY / 2 + WEEK * 10);
            expect(await stableSwap.getAmpl()).to.equal(Math.floor(AMPL / 2));
        });

        it("Should emit an event", async function () {
            await expect(stableSwap.updateAmplRamp(AMPL * 2, startTimestamp + DAY))
                .to.emit(stableSwap, "AmplRampUpdated")
                .withArgs(AMPL, AMPL * 2, startTimestamp, startTimestamp + DAY);
        });
    });

    describe("SwapRouter", function () {
        let startTimestamp: number;

        beforeEach(async function () {
            startTimestamp = (await ethers.provider.getBlock("latest")).timestamp - 1;
            await btc.mint(addr1, INIT_BTC);
            await btc.connect(user1).approve(swapRouter.address, INIT_BTC);
        });

        it("Should check deadline", async function () {
            await expect(
                swapRouter.addLiquidity(
                    tmpBase.address,
                    btc.address,
                    0,
                    0,
                    0,
                    0,
                    startTimestamp - 1
                )
            ).to.be.revertedWith("Transaction too old");
            await expect(
                swapRouter.swapExactTokensForTokens(
                    0,
                    0,
                    [tmpBase.address, btc.address],
                    addr1,
                    ethers.constants.AddressZero,
                    [0],
                    startTimestamp - 1
                )
            ).to.be.revertedWith("Transaction too old");
            await expect(
                swapRouter.swapTokensForExactTokens(
                    0,
                    0,
                    [tmpBase.address, btc.address],
                    addr1,
                    ethers.constants.AddressZero,
                    [0],
                    startTimestamp - 1
                )
            ).to.be.revertedWith("Transaction too old");
        });

        describe("addLiquidity()", function () {
            const routerAddLiquidity = (
                inQ: BigNumberish,
                inBtc: BigNumberish,
                outLp: BigNumberish
            ) =>
                swapRouter.addLiquidity(
                    tmpBase.address,
                    btc.address,
                    inQ,
                    inBtc,
                    outLp,
                    0,
                    startTimestamp + DAY
                );

            it("Should revert if the swap is not found", async function () {
                await expect(
                    swapRouter.addLiquidity(addr1, btc.address, 0, 0, 0, 0, startTimestamp + DAY)
                ).to.be.revertedWith("Unknown swap");
            });

            it("Should transfer base tokens", async function () {
                await addBase(parseEther("0.123")); // Mock effect of the base token transfer
                await expect(() => routerAddLiquidity(parseEther("0.123"), 0, 0)).to.callMocks({
                    func: tmpBase.mock.transferFrom.withArgs(
                        addr1,
                        stableSwap.address,
                        parseEther("0.123")
                    ),
                    rets: [true],
                });
            });

            it("Should transfer quote tokens", async function () {
                await tmpBase.mock.transferFrom.returns(true);
                await expect(() =>
                    routerAddLiquidity(0, parseBtc("0.123"), 0)
                ).to.changeTokenBalances(
                    btc,
                    [user1, stableSwap],
                    [parseBtc("-0.123"), parseBtc("0.123")]
                );
            });

            it("Should check min output", async function () {
                await addBase(INIT_Q.div(2)); // Mock effect of the base token transfer
                await tmpBase.mock.transferFrom.returns(true);
                await expect(
                    routerAddLiquidity(INIT_Q.div(2), INIT_BTC.div(2), INIT_LP.div(2).add(1))
                ).to.be.revertedWith("Insufficient output");
                await routerAddLiquidity(INIT_Q.div(2), INIT_BTC.div(2), INIT_LP.div(2));
            });
        });

        describe("swapExactTokensForTokens", function () {
            const callSwap = (
                amountIn: BigNumberish,
                minAmountOut: BigNumberish,
                path: string[],
                versions: number[]
            ) =>
                swapRouter.swapExactTokensForTokens(
                    amountIn,
                    minAmountOut,
                    path,
                    addr2,
                    ethers.constants.AddressZero,
                    versions,
                    startTimestamp + DAY
                );
            const callBuy = (amountIn: BigNumberish, minAmountOut: BigNumberish) =>
                callSwap(amountIn, minAmountOut, [btc.address, tmpBase.address], [0]);
            const callSell = (amountIn: BigNumberish, minAmountOut: BigNumberish) =>
                callSwap(amountIn, minAmountOut, [tmpBase.address, btc.address], [0]);

            it("Should reject invalid path or versions", async function () {
                await expect(callSwap(0, 0, [btc.address], [0])).to.be.revertedWith("Invalid path");
                await expect(callSwap(0, 0, [tmpBase.address, btc.address], [])).to.be.revertedWith(
                    "Invalid versions"
                );
                await expect(callSwap(0, 0, [addr1, btc.address], [0])).to.be.revertedWith(
                    "Unknown swap"
                );
            });

            it("Should transfer base tokens", async function () {
                // Sell
                await addBase(parseEther("0.123")); // Mock effect of the base token transfer
                await expect(() => callSell(parseEther("0.123"), 0)).to.callMocks({
                    func: tmpBase.mock.transferFrom.withArgs(
                        addr1,
                        stableSwap.address,
                        parseEther("0.123")
                    ),
                    rets: [true],
                });
                // Buy
                const inBtc = parseBtc("0.456");
                const outQ = await stableSwap.getBaseOut(inBtc);
                await expect(() => callBuy(inBtc, 0)).to.callMocks({
                    func: tmpBase.mock.transfer.withArgs(addr2, outQ),
                    rets: [true],
                });
            });

            it("Should transfer quote tokens", async function () {
                await tmpBase.mock.transfer.returns(true);
                await tmpBase.mock.transferFrom.returns(true);
                // Sell
                const inQ = parseEther("0.123");
                const outBtc = await stableSwap.getQuoteOut(inQ);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(() => callSell(inQ, 0)).to.changeTokenBalances(
                    btc,
                    [user2, stableSwap],
                    [outBtc, outBtc.mul(-1)]
                );
                // Buy
                await expect(() => callBuy(parseBtc("0.456"), 0)).to.changeTokenBalances(
                    btc,
                    [user1, stableSwap],
                    [parseBtc("-0.456"), parseBtc("0.456")]
                );
            });

            it("Should check min output", async function () {
                await tmpBase.mock.transfer.returns(true);
                await tmpBase.mock.transferFrom.returns(true);
                // Sell
                const inQ = parseEther("0.123");
                const outBtc = await stableSwap.getQuoteOut(inQ);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(callSell(inQ, outBtc.add(1))).to.be.revertedWith(
                    "Insufficient output"
                );
                await callSell(inQ, outBtc);
                // Buy
                const inBtc = parseBtc("0.456");
                const outQ = await stableSwap.getBaseOut(inBtc);
                await expect(callBuy(inBtc, outQ.add(1))).to.be.revertedWith("Insufficient output");
                await callBuy(inBtc, outQ);
            });
        });

        describe("swapTokensForExactTokens", function () {
            const callSwap = (
                amountOut: BigNumberish,
                maxAmountIn: BigNumberish,
                path: string[],
                versions: number[]
            ) =>
                swapRouter.swapTokensForExactTokens(
                    amountOut,
                    maxAmountIn,
                    path,
                    addr2,
                    ethers.constants.AddressZero,
                    versions,
                    startTimestamp + DAY
                );
            const callBuy = (amountOut: BigNumberish, maxAmountIn: BigNumberish) =>
                callSwap(amountOut, maxAmountIn, [btc.address, tmpBase.address], [0]);
            const callSell = (amountOut: BigNumberish, maxAmountIn: BigNumberish) =>
                callSwap(amountOut, maxAmountIn, [tmpBase.address, btc.address], [0]);

            it("Should reject invalid path or versions", async function () {
                await expect(callSwap(0, 0, [btc.address], [0])).to.be.revertedWith("Invalid path");
                await expect(callSwap(0, 0, [tmpBase.address, btc.address], [])).to.be.revertedWith(
                    "Invalid versions"
                );
                await expect(callSwap(0, 0, [addr1, btc.address], [0])).to.be.revertedWith(
                    "Unknown swap"
                );
            });

            it("Should transfer base tokens", async function () {
                // Sell
                const outBtc = parseBtc("0.123");
                const inQ = await stableSwap.getBaseIn(outBtc);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(() => callSell(outBtc, parseEther("999"))).to.callMocks({
                    func: tmpBase.mock.transferFrom.withArgs(addr1, stableSwap.address, inQ),
                    rets: [true],
                });
                // Buy
                await expect(() => callBuy(parseEther("0.456"), parseBtc("999"))).to.callMocks({
                    func: tmpBase.mock.transfer.withArgs(addr2, parseEther("0.456")),
                    rets: [true],
                });
            });

            it("Should transfer quote tokens", async function () {
                await tmpBase.mock.transfer.returns(true);
                await tmpBase.mock.transferFrom.returns(true);
                // Sell
                const outBtc = parseBtc("0.123");
                const inQ = await stableSwap.getBaseIn(outBtc);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(() => callSell(outBtc, parseEther("999"))).to.changeTokenBalances(
                    btc,
                    [user2, stableSwap],
                    [outBtc, outBtc.mul(-1)]
                );
                // Buy
                const outQ = parseEther("0.456");
                const inBtc = await stableSwap.getQuoteIn(outQ);
                await expect(() => callBuy(outQ, parseBtc("999"))).to.changeTokenBalances(
                    btc,
                    [user1, stableSwap],
                    [inBtc.mul(-1), inBtc]
                );
            });

            it("Should check max input", async function () {
                await tmpBase.mock.transfer.returns(true);
                await tmpBase.mock.transferFrom.returns(true);
                // Sell
                const outBtc = parseBtc("0.123");
                const inQ = await stableSwap.getBaseIn(outBtc);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(callSell(outBtc, inQ.sub(1))).to.be.revertedWith("Excessive input");
                await callSell(outBtc, inQ.mul(10));
                // Buy
                const outQ = parseEther("0.456");
                const inBtc = await stableSwap.getQuoteIn(outQ);
                await expect(callBuy(outQ, inBtc.sub(1))).to.be.revertedWith("Excessive input");
                await callBuy(outQ, inBtc);
            });
        });
    });
});
