import { expect } from "chai";
import { BigNumber, BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseUsdc = (value: string) => parseUnits(value, 6);
import { deployMockForName } from "./mock";
import {
    TRANCHE_Q,
    TRANCHE_B,
    TRANCHE_R,
    DAY,
    WEEK,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";

const USDC_TO_ETHER = parseUnits("1", 12);
const UNIT = parseEther("1");
const AMPL = 80;
const FEE_RATE = parseEther("0.03");
const ADMIN_FEE_RATE = parseEther("0.4");
const TRADING_CURB_THRESHOLD = parseEther("0.35");

const INIT_B = parseEther("100000");
const INIT_USDC = parseUsdc("100000");
const INIT_LP = parseEther("200000");

describe("BishopStableSwap", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly usdc: Contract;
        readonly fund: MockContract;
        readonly tokenB: MockContract;
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
    let usdc: Contract;
    let fund: MockContract;
    let tokenB: MockContract;
    let lpToken: Contract;
    let stableSwap: Contract;
    let swapRouter: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector] = provider.getWallets();

        const MockToken = await ethers.getContractFactory("MockToken");
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);
        const twapOracle = await deployMockForName(owner, "ITwapOracleV2");
        await twapOracle.mock.getLatest.returns(parseEther("1000"));
        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.twapOracle.returns(twapOracle.address);
        await fund.mock.getRebalanceSize.returns(0);
        // Set oracle price to 1
        await fund.mock.extrapolateNav.returns(parseEther("2"), parseEther("1"), parseEther("1"));

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        await chessSchedule.mock.getRate.returns(UNIT);
        const chessController = await deployMockForName(owner, "ChessController");
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
        const StableSwap = await ethers.getContractFactory("BishopStableSwap");
        const stableSwap = await StableSwap.connect(owner).deploy(
            lpTokenAddress,
            fund.address,
            usdc.address,
            6,
            AMPL,
            feeCollector.address,
            FEE_RATE,
            ADMIN_FEE_RATE,
            TRADING_CURB_THRESHOLD
        );
        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const lpToken = await LiquidityGauge.connect(owner).deploy(
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

        const tokenB = await deployMockForName(owner, "ERC20");
        await fund.mock.tokenShare.withArgs(TRANCHE_B).returns(tokenB.address);

        // Add initial liquidity
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_B, stableSwap.address).returns(INIT_B);
        await usdc.mint(stableSwap.address, INIT_USDC);
        await stableSwap.addLiquidity(0, user1.address);

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();
        await swapRouter.addSwap(tokenB.address, usdc.address, stableSwap.address);

        return {
            wallets: { user1, user2, owner, feeCollector },
            usdc,
            fund,
            tokenB,
            lpToken,
            stableSwap: stableSwap.connect(user1),
            swapRouter: swapRouter.connect(user1),
        };
    }

    async function setOraclePrice(p: BigNumberish): Promise<void> {
        await fund.mock.extrapolateNav.returns(BigNumber.from(p).mul(2), p, p);
    }

    async function addBase(amount: BigNumberish): Promise<void> {
        const oldBase = await fund.trancheBalanceOf(TRANCHE_B, stableSwap.address);
        await fund.mock.trancheBalanceOf
            .withArgs(TRANCHE_B, stableSwap.address)
            .returns(oldBase.add(amount));
    }

    async function addQuote(amount: BigNumberish): Promise<void> {
        await usdc.mint(stableSwap.address, amount);
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
        usdc = fixtureData.usdc;
        fund = fixtureData.fund;
        tokenB = fixtureData.tokenB;
        lpToken = fixtureData.lpToken;
        stableSwap = fixtureData.stableSwap;
        swapRouter = fixtureData.swapRouter;
    });

    describe("Price and slippage", function () {
        function testGetPrice(price: BigNumber): () => Promise<void> {
            return async function () {
                const priceOverOracle = price;
                expect(await stableSwap.getCurrentPriceOverOracle()).to.be.closeTo(
                    priceOverOracle,
                    priceOverOracle.div(10000)
                );
                expect(await stableSwap.getCurrentPrice()).to.be.closeTo(price, price.div(10000));

                await addQuote((await usdc.balanceOf(stableSwap.address)).mul(2)); // Triple quote balance
                await stableSwap.sync();
                await setOraclePrice(parseEther("3")); // Triple oracle price
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

        function testGetBaseOut(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const inUsdc = INIT_USDC.div(swapFraction);
                const outQ = await stableSwap.getBaseOut(inUsdc);
                const fee = inUsdc.mul(FEE_RATE).div(UNIT);
                const swapPrice = inUsdc.sub(fee).mul(USDC_TO_ETHER).mul(UNIT).div(outQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addQuote(inUsdc);
                await stableSwap.buy(0, outQ, addr1, "0x");
            };
        }

        function testGetQuoteIn(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const outQ = INIT_B.div(swapFraction);
                const inUsdc = await stableSwap.getQuoteIn(outQ);
                const fee = inUsdc.mul(FEE_RATE).div(UNIT);
                const swapPrice = inUsdc.sub(fee).mul(USDC_TO_ETHER).mul(UNIT).div(outQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addQuote(inUsdc);
                await stableSwap.buy(0, outQ, addr1, "0x");
            };
        }

        function testGetQuoteOut(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const inQ = INIT_B.div(swapFraction);
                const outUsdc = await stableSwap.getQuoteOut(inQ);
                const fee = outUsdc.mul(FEE_RATE).div(UNIT.sub(FEE_RATE));
                const swapPrice = outUsdc.add(fee).mul(USDC_TO_ETHER).mul(UNIT).div(inQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addBase(inQ);
                await stableSwap.sell(0, outUsdc, addr1, "0x");
            };
        }

        function testGetBaseIn(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const outUsdc = INIT_USDC.div(swapFraction);
                const inQ = await stableSwap.getBaseIn(outUsdc);
                const fee = outUsdc.mul(FEE_RATE).div(UNIT.sub(FEE_RATE));
                const swapPrice = outUsdc.add(fee).mul(USDC_TO_ETHER).mul(UNIT).div(inQ);
                expect(swapPrice).to.be.closeTo(price, price.mul(slippageBps).div(10000));
                await addBase(inQ);
                await stableSwap.sell(0, outUsdc, addr1, "0x");
            };
        }

        function testAddBase(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const inUsdc = INIT_USDC.div(swapFraction);
                // Estimate LP token amount and fee (slippage ignored)
                const oldUsdc = await usdc.balanceOf(stableSwap.address);
                const oldQ = await fund.trancheBalanceOf(TRANCHE_B, stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldUsdc.mul(USDC_TO_ETHER));
                const newValue = oldValue.add(inUsdc.mul(USDC_TO_ETHER));
                const swappedUsdc = inUsdc.sub(oldUsdc.mul(newValue.sub(oldValue)).div(oldValue));
                const fee = swappedUsdc.mul(FEE_RATE).div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const lp = inUsdc.sub(fee).mul(USDC_TO_ETHER).mul(INIT_LP).div(oldValue);
                // Check the estimation
                await addQuote(inUsdc);
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

        function testAddQuote(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const inQ = INIT_B.div(swapFraction);
                // Estimate LP token amount and fee (slippage ignored)
                const oldUsdc = await usdc.balanceOf(stableSwap.address);
                const oldQ = await fund.trancheBalanceOf(TRANCHE_B, stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldUsdc.mul(USDC_TO_ETHER));
                const newValue = oldValue.add(inQ.mul(price).div(UNIT));
                const swappedUsdc = oldUsdc.mul(newValue.sub(oldValue)).div(oldValue);
                const fee = swappedUsdc.mul(FEE_RATE).div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const lp = newValue
                    .sub(fee.mul(USDC_TO_ETHER))
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

        function testRemoveBase(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const inLp = INIT_LP.div(swapFraction);
                // Estimate output amount and fee (slippage ignored)
                const oldUsdc = await usdc.balanceOf(stableSwap.address);
                const oldQ = await fund.trancheBalanceOf(TRANCHE_B, stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldUsdc.mul(USDC_TO_ETHER));
                const removedValue = oldValue.div(swapFraction);
                const fee = oldUsdc.div(swapFraction).mul(FEE_RATE).div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const outQ = removedValue.sub(fee.mul(USDC_TO_ETHER)).mul(UNIT).div(price);
                // Check the estimation
                await fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr1, outQ, 0);
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

        function testRemoveQuote(
            price: BigNumber,
            swapFraction: number,
            slippageBps: number
        ): () => Promise<void> {
            return async function () {
                const inLp = INIT_LP.div(swapFraction);
                // Estimate output amount and fee (slippage ignored)
                const oldUsdc = await usdc.balanceOf(stableSwap.address);
                const oldQ = await fund.trancheBalanceOf(TRANCHE_B, stableSwap.address);
                const oldValue = oldQ.mul(price).div(UNIT).add(oldUsdc.mul(USDC_TO_ETHER));
                const removedValue = oldValue.div(swapFraction);
                const fee = oldQ
                    .div(swapFraction)
                    .mul(price)
                    .div(UNIT)
                    .div(USDC_TO_ETHER)
                    .mul(FEE_RATE)
                    .div(UNIT);
                const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
                const outUsdc = removedValue.div(USDC_TO_ETHER).sub(fee);
                // Check the estimation
                expect(await stableSwap.callStatic.removeQuoteLiquidity(0, inLp, 0)).to.be.closeTo(
                    outUsdc,
                    outUsdc.mul(slippageBps).div(10000)
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
            await fund.mock.trancheTransfer.returns();
        });

        describe("Balanced pool", function () {
            const PRICE = parseEther("1");

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1000, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1000, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1000, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1000, 1));
            it("Add base tokens", testAddBase(PRICE, 1000, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1000, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 2000, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 2000, 1));
        });

        describe("Balanced pool with very small swap amount", function () {
            const PRICE = parseEther("1");

            it("getBaseOut()", testGetBaseOut(PRICE, 100000, 10));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 100000, 10));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 100000, 10));
            it("getBaseIn()", testGetBaseIn(PRICE, 100000, 10));
            it("Add base tokens", testAddBase(PRICE, 100000, 10));
            it("Add quote tokens", testAddQuote(PRICE, 100000, 10));
            it("Remove base tokens", testRemoveBase(PRICE, 200000, 10));
            it("Remove quote tokens", testRemoveQuote(PRICE, 200000, 10));
        });

        describe("10 bps premium at base:quote=1:1.174 (Ampl=80)", function () {
            const PRICE = parseEther("1.001");

            beforeEach(async function () {
                await addQuote(INIT_USDC.mul(174).div(1000));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1000, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1000, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1000, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1000, 1));
            it("Add base tokens", testAddBase(PRICE, 1000, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1000, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 2000, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 2000, 1));
        });

        describe("10 bps discount at base:quote=1.174:1 (Ampl=80)", function () {
            const PRICE = parseEther("0.999");

            beforeEach(async function () {
                await addBase(INIT_B.mul(174).div(1000));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1000, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1000, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1000, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1000, 1));
            it("Add base tokens", testAddBase(PRICE, 1000, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1000, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 2000, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 2000, 1));
        });

        describe("1% premium at base:quote=1:2.85 (Ampl=80)", async function () {
            const PRICE = parseEther("1.01");

            beforeEach(async function () {
                await addQuote(INIT_USDC.mul(185).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1000, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1000, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1000, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1000, 1));
            it("Add base tokens", testAddBase(PRICE, 1000, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1000, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 2000, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 2000, 1));
        });

        describe("1% discount at base:quote=2.85:1 (Ampl=80)", function () {
            const PRICE = parseEther("0.99");

            beforeEach(async function () {
                await addBase(INIT_B.mul(185).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1000, 1));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1000, 1));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1000, 1));
            it("getBaseIn()", testGetBaseIn(PRICE, 1000, 1));
            it("Add base tokens", testAddBase(PRICE, 1000, 1));
            it("Add quote tokens", testAddQuote(PRICE, 1000, 1));
            it("Remove base tokens", testRemoveBase(PRICE, 2000, 1));
            it("Remove quote tokens", testRemoveQuote(PRICE, 2000, 1));
        });

        describe("100x price at base:quote=1:560.24 (Ampl=80)", async function () {
            const PRICE = parseEther("100");

            beforeEach(async function () {
                await addQuote(INIT_USDC.mul(55924).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1000, 10));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1000, 10));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1000, 10));
            it("getBaseIn()", testGetBaseIn(PRICE, 1000, 10));
            it("Add base tokens", testAddBase(PRICE, 1000, 10));
            it("Add quote tokens", testAddQuote(PRICE, 1000, 10));
            it("Remove base tokens", testRemoveBase(PRICE, 10000, 10));
            it("Remove quote tokens", testRemoveQuote(PRICE, 10000, 10));
        });

        describe("1/100 price at base:quote=560.24:1 (Ampl=80)", async function () {
            const PRICE = parseEther("0.01");

            beforeEach(async function () {
                await addBase(INIT_B.mul(55924).div(100));
                await stableSwap.sync();
            });

            it("getCurrentPrice()", testGetPrice(PRICE));
            it("getBaseOut()", testGetBaseOut(PRICE, 1000, 10));
            it("getQuoteIn()", testGetQuoteIn(PRICE, 1000, 10));
            it("getQuoteOut()", testGetQuoteOut(PRICE, 1000, 10));
            it("getBaseIn()", testGetBaseIn(PRICE, 1000, 10));
            it("Add base tokens", testAddBase(PRICE, 1000, 10));
            it("Add quote tokens", testAddQuote(PRICE, 1000, 10));
            it("Remove base tokens", testRemoveBase(PRICE, 10000, 10));
            it("Remove quote tokens", testRemoveQuote(PRICE, 10000, 10));
        });
    });

    describe("buy()", function () {
        let inUsdc: BigNumber;
        let outQ: BigNumber;
        let fee: BigNumber;
        let adminFee: BigNumber;

        this.beforeEach(async function () {
            inUsdc = INIT_USDC.div(1000);
            outQ = await stableSwap.getBaseOut(inUsdc);
            fee = inUsdc.mul(FEE_RATE).div(UNIT);
            adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
        });

        it("Should revert if output is zero", async function () {
            await expect(stableSwap.buy(0, 0, addr1, "0x")).to.be.revertedWith("Zero output");
        });

        it("Should revert if output exceeds liquidity", async function () {
            await expect(stableSwap.buy(0, INIT_B, addr1, "0x")).to.be.revertedWith(
                "Insufficient liquidity"
            );
        });

        it("Should revert if input is not sufficient", async function () {
            await addQuote(inUsdc.mul(9).div(10));
            await fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr1, outQ, 0).returns();
            await expect(stableSwap.buy(0, outQ, addr1, "0x")).to.be.revertedWith(
                "Invariant mismatch"
            );
        });

        it("Should transfer base token to recipient", async function () {
            await addQuote(inUsdc);
            await expect(() => stableSwap.buy(0, outQ, addr2, "0x")).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr2, outQ, 0),
                rets: [],
            });
        });

        it("Should update stored balance and admin fee", async function () {
            await addQuote(inUsdc);
            await fund.mock.trancheTransfer.returns();
            await stableSwap.buy(0, outQ, addr2, "0x");
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_B.sub(outQ));
            expect(quote).to.equal(INIT_USDC.add(inUsdc).sub(adminFee));
            expect(await stableSwap.totalAdminFee()).to.equal(adminFee);
        });

        it("Should emit an event", async function () {
            await addQuote(inUsdc);
            await fund.mock.trancheTransfer.returns();
            await expect(stableSwap.buy(0, outQ, addr2, "0x"))
                .to.emit(stableSwap, "Swap")
                .withArgs(addr1, addr2, 0, inUsdc, outQ, 0, fee, adminFee, parseEther("1"));
        });
    });

    describe("sell()", function () {
        let inQ: BigNumber;
        let outUsdc: BigNumber;
        let fee: BigNumber;
        let adminFee: BigNumber;

        this.beforeEach(async function () {
            inQ = INIT_B.div(1000);
            outUsdc = await stableSwap.getQuoteOut(inQ);
            fee = outUsdc.mul(FEE_RATE).div(UNIT.sub(FEE_RATE));
            adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);
        });

        it("Should revert if output is zero", async function () {
            await expect(stableSwap.sell(0, 0, addr1, "0x")).to.be.revertedWith("Zero output");
        });

        it("Should revert if output exceeds liquidity", async function () {
            await expect(stableSwap.sell(0, INIT_USDC, addr1, "0x")).to.be.revertedWith(
                "Insufficient liquidity"
            );
        });

        it("Should revert if input is not sufficient", async function () {
            await addBase(inQ.mul(9).div(10));
            await expect(stableSwap.sell(0, outUsdc, addr1, "0x")).to.be.revertedWith(
                "Invariant mismatch"
            );
        });

        it("Should transfer quote token to recipient", async function () {
            await addBase(inQ);
            await expect(() => stableSwap.sell(0, outUsdc, addr2, "0x")).to.changeTokenBalances(
                usdc,
                [user2, stableSwap],
                [outUsdc, outUsdc.mul(-1)]
            );
        });

        it("Should update stored balance and admin fee", async function () {
            await addBase(inQ);
            await stableSwap.sell(0, outUsdc, addr2, "0x");
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_B.add(inQ));
            expect(quote).to.equal(INIT_USDC.sub(outUsdc).sub(adminFee));
            expect(await stableSwap.totalAdminFee()).to.equal(adminFee);
        });

        it("Should emit an event", async function () {
            await addBase(inQ);
            await fund.mock.trancheTransfer.returns();
            await expect(stableSwap.sell(0, outUsdc, addr2, "0x"))
                .to.emit(stableSwap, "Swap")
                .withArgs(addr1, addr2, inQ, 0, 0, outUsdc, fee, adminFee, parseEther("1"));
        });
    });

    describe("addLiquidity()", function () {
        it("Should mint initial LP tokens", async function () {
            expect(await lpToken.totalSupply()).to.equal(INIT_LP);
            expect(await lpToken.balanceOf(addr1)).to.equal(INIT_LP.sub(1000));
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_B);
            expect(quote).to.equal(INIT_USDC);
        });

        it("Should revert if no liquidity is added", async function () {
            await expect(stableSwap.addLiquidity(0, addr1)).to.be.revertedWith(
                "No liquidity is added"
            );
        });

        it("Should mint LP tokens proportionally", async function () {
            await addBase(INIT_B.div(2));
            await addQuote(INIT_USDC.div(2));
            await stableSwap.addLiquidity(0, addr2);
            expect(await lpToken.balanceOf(addr2)).to.equal(INIT_LP.div(2));
        });

        it("Should return minted amount", async function () {
            await addBase(INIT_B.div(2));
            await addQuote(INIT_USDC.div(2));
            expect(await stableSwap.callStatic.addLiquidity(0, addr1)).to.equal(INIT_LP.div(2));
        });

        it("Should update stored balance", async function () {
            await addBase(INIT_B.div(2));
            await addQuote(INIT_USDC.div(2));
            await stableSwap.addLiquidity(0, addr2);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_B.mul(3).div(2));
            expect(quote).to.equal(INIT_USDC.mul(3).div(2));
        });

        it("Should emit an event", async function () {
            await addBase(INIT_B.div(2));
            await addQuote(INIT_USDC.div(2));
            await expect(stableSwap.addLiquidity(0, addr2))
                .to.emit(stableSwap, "LiquidityAdded")
                .withArgs(
                    addr1,
                    addr2,
                    INIT_B.div(2),
                    INIT_USDC.div(2),
                    INIT_LP.div(2),
                    0,
                    0,
                    parseEther("1")
                );
        });
    });

    describe("removeLiquidity()", function () {
        it("Should burn LP tokens", async function () {
            await fund.mock.trancheTransfer.returns();
            await expect(() =>
                stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0)
            ).to.changeTokenBalance(lpToken, user1, INIT_LP.div(-10));
        });

        it("Should transfer base tokens", async function () {
            await expect(() => stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0)).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr1, INIT_B.div(10), 0),
                rets: [],
            });
        });

        it("Should transfer quote tokens", async function () {
            await fund.mock.trancheTransfer.returns();
            await expect(() =>
                stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0)
            ).to.changeTokenBalances(
                usdc,
                [user1, stableSwap],
                [INIT_USDC.div(10), INIT_USDC.div(-10)]
            );
        });

        it("Should return base and quote amount", async function () {
            await fund.mock.trancheTransfer.returns();
            const ret = await stableSwap.callStatic.removeLiquidity(0, INIT_LP.div(10), 0, 0);
            expect(ret.baseOut).to.equal(INIT_B.div(10));
            expect(ret.quoteOut).to.equal(INIT_USDC.div(10));
        });

        it("Should check min output", async function () {
            await fund.mock.trancheTransfer.returns();
            await expect(
                stableSwap.removeLiquidity(0, INIT_LP.div(10), INIT_B.div(10).add(1), 0)
            ).to.be.revertedWith("Insufficient output");
            await expect(
                stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, INIT_USDC.div(10).add(1))
            ).to.be.revertedWith("Insufficient output");
            await stableSwap.removeLiquidity(0, INIT_LP.div(10), INIT_B.div(10), INIT_USDC.div(10));
        });

        it("Should update stored balance", async function () {
            await fund.mock.trancheTransfer.returns();
            await stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_B.mul(9).div(10));
            expect(quote).to.equal(INIT_USDC.mul(9).div(10));
        });

        it("Should emit an event", async function () {
            await fund.mock.trancheTransfer.returns();
            await expect(stableSwap.removeLiquidity(0, INIT_LP.div(10), 0, 0))
                .to.emit(stableSwap, "LiquidityRemoved")
                .withArgs(addr1, INIT_LP.div(10), INIT_B.div(10), INIT_USDC.div(10), 0, 0, 0);
        });
    });

    describe("removeBaseLiquidity()", function () {
        let inLp: BigNumber;
        let outQ: BigNumber;

        this.beforeEach(async function () {
            inLp = INIT_LP.div(1000);
            await fund.mock.trancheTransfer.returns();
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
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr1, outQ, 0),
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
            expect(base).to.equal(INIT_B.sub(outQ));
            expect(quote).to.equal(INIT_USDC.sub(await stableSwap.totalAdminFee()));
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
        let outUsdc: BigNumber;

        this.beforeEach(async function () {
            inLp = INIT_LP.div(1000);
            outUsdc = await stableSwap.callStatic.removeQuoteLiquidity(0, inLp, 0);
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
                usdc,
                [user1, stableSwap],
                [outUsdc, outUsdc.mul(-1)]
            );
        });

        it("Should check min output", async function () {
            await expect(
                stableSwap.removeQuoteLiquidity(0, inLp, outUsdc.add(1))
            ).to.be.revertedWith("Insufficient output");
            await stableSwap.removeQuoteLiquidity(0, inLp, outUsdc);
        });

        it("Should update stored balance", async function () {
            await stableSwap.removeQuoteLiquidity(0, inLp, 0);
            const [base, quote] = await stableSwap.allBalances();
            expect(base).to.equal(INIT_B);
            expect(quote).to.equal(INIT_USDC.sub(outUsdc).sub(await stableSwap.totalAdminFee()));
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
            expect(base).to.equal(INIT_B.add(parseEther("0.123")));
            expect(quote).to.equal(INIT_USDC.add(parseEther("0.456")));
        });

        it("Should emit an event", async function () {
            await addBase(parseEther("0.123"));
            await addQuote(parseEther("0.456"));
            await expect(stableSwap.sync())
                .to.emit(stableSwap, "Sync")
                .withArgs(
                    INIT_B.add(parseEther("0.123")),
                    INIT_USDC.add(parseEther("0.456")),
                    parseEther("1")
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
            await fund.mock.trancheTransfer.returns();
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
            const inUsdc = INIT_USDC.div(10);
            const outQ = await stableSwap.getBaseOut(inUsdc);
            await addQuote(inUsdc);
            await testIntegralUpdate(stableSwap.buy(0, outQ, addr1, "0x"));
        });

        it("Should update integral in sell()", async function () {
            const inQ = INIT_B.div(10);
            const outUsdc = await stableSwap.getQuoteOut(inQ);
            await addBase(inQ);
            await testIntegralUpdate(stableSwap.sell(0, outUsdc, addr1, "0x"));
        });

        it("Should update integral in addLiquidity()", async function () {
            await addBase(INIT_B.div(10));
            await testIntegralUpdate(stableSwap.addLiquidity(0, addr2));
        });

        it("Should update integral in removeBaseLiquidity()", async function () {
            await testIntegralUpdate(stableSwap.removeBaseLiquidity(0, INIT_LP.div(10), 0));
        });

        it("Should update integral in removeQuoteLiquidity()", async function () {
            await testIntegralUpdate(stableSwap.removeQuoteLiquidity(0, INIT_LP.div(10), 0));
        });

        it("Should update integral in sync()", async function () {
            await addBase(INIT_B.div(10));
            await testIntegralUpdate(stableSwap.sync());
        });
    });

    describe("collectFee()", function () {
        it("Should transfer admin fee", async function () {
            await addBase(INIT_B.div(100));
            await stableSwap.addLiquidity(0, addr2);
            await stableSwap.removeQuoteLiquidity(0, INIT_LP.div(100), 0);
            const adminFee = await stableSwap.totalAdminFee();
            expect(adminFee).to.gt(0);
            await expect(() => stableSwap.collectFee()).to.changeTokenBalances(
                usdc,
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
            await usdc.mint(addr1, INIT_USDC);
            await usdc.connect(user1).approve(swapRouter.address, INIT_USDC);
        });

        it("Should check deadline", async function () {
            await expect(
                swapRouter.addLiquidity(
                    tokenB.address,
                    usdc.address,
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
                    [tokenB.address, usdc.address],
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
                    [tokenB.address, usdc.address],
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
                inUsdc: BigNumberish,
                outLp: BigNumberish
            ) =>
                swapRouter.addLiquidity(
                    tokenB.address,
                    usdc.address,
                    inQ,
                    inUsdc,
                    outLp,
                    0,
                    startTimestamp + DAY
                );

            it("Should revert if the swap is not found", async function () {
                await expect(
                    swapRouter.addLiquidity(addr1, usdc.address, 0, 0, 0, 0, startTimestamp + DAY)
                ).to.be.revertedWith("Unknown swap");
            });

            it("Should transfer base tokens", async function () {
                await addBase(parseEther("0.123")); // Mock effect of the base token transfer
                await expect(() => routerAddLiquidity(parseEther("0.123"), 0, 0)).to.callMocks({
                    func: fund.mock.trancheTransferFrom.withArgs(
                        TRANCHE_B,
                        addr1,
                        stableSwap.address,
                        parseEther("0.123"),
                        0
                    ),
                });
            });

            it("Should transfer quote tokens", async function () {
                await fund.mock.trancheTransferFrom.returns();
                await expect(() =>
                    routerAddLiquidity(0, parseUsdc("0.123"), 0)
                ).to.changeTokenBalances(
                    usdc,
                    [user1, stableSwap],
                    [parseUsdc("-0.123"), parseUsdc("0.123")]
                );
            });

            it("Should check min output", async function () {
                await addBase(INIT_B.div(2)); // Mock effect of the base token transfer
                await fund.mock.trancheTransferFrom.returns();
                await expect(
                    routerAddLiquidity(INIT_B.div(2), INIT_USDC.div(2), INIT_LP.div(2).add(1))
                ).to.be.revertedWith("Insufficient output");
                await routerAddLiquidity(INIT_B.div(2), INIT_USDC.div(2), INIT_LP.div(2));
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
                callSwap(amountIn, minAmountOut, [usdc.address, tokenB.address], [0]);
            const callSell = (amountIn: BigNumberish, minAmountOut: BigNumberish) =>
                callSwap(amountIn, minAmountOut, [tokenB.address, usdc.address], [0]);

            it("Should reject invalid path or versions", async function () {
                await expect(callSwap(0, 0, [usdc.address], [0])).to.be.revertedWith(
                    "Invalid path"
                );
                await expect(callSwap(0, 0, [tokenB.address, usdc.address], [])).to.be.revertedWith(
                    "Invalid versions"
                );
                await expect(callSwap(0, 0, [addr1, usdc.address], [0])).to.be.revertedWith(
                    "Unknown swap"
                );
            });

            it("Should transfer base tokens", async function () {
                // Sell
                await addBase(parseEther("0.123")); // Mock effect of the base token transfer
                await expect(() => callSell(parseEther("0.123"), 0)).to.callMocks({
                    func: fund.mock.trancheTransferFrom.withArgs(
                        TRANCHE_B,
                        addr1,
                        stableSwap.address,
                        parseEther("0.123"),
                        0
                    ),
                });
                // Buy
                const inUsdc = parseUsdc("0.456");
                const outQ = await stableSwap.getBaseOut(inUsdc);
                await expect(() => callBuy(inUsdc, 0)).to.callMocks({
                    func: fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr2, outQ, 0),
                });
            });

            it("Should transfer quote tokens", async function () {
                await fund.mock.trancheTransfer.returns();
                await fund.mock.trancheTransferFrom.returns();
                // Sell
                const inQ = parseEther("0.123");
                const outUsdc = await stableSwap.getQuoteOut(inQ);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(() => callSell(inQ, 0)).to.changeTokenBalances(
                    usdc,
                    [user2, stableSwap],
                    [outUsdc, outUsdc.mul(-1)]
                );
                // Buy
                await expect(() => callBuy(parseUsdc("0.456"), 0)).to.changeTokenBalances(
                    usdc,
                    [user1, stableSwap],
                    [parseUsdc("-0.456"), parseUsdc("0.456")]
                );
            });

            it("Should check min output", async function () {
                await fund.mock.trancheTransfer.returns();
                await fund.mock.trancheTransferFrom.returns();
                // Sell
                const inQ = parseEther("0.123");
                const outUsdc = await stableSwap.getQuoteOut(inQ);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(callSell(inQ, outUsdc.add(1))).to.be.revertedWith(
                    "Insufficient output"
                );
                await callSell(inQ, outUsdc);
                // Buy
                const inUsdc = parseUsdc("0.456");
                const outQ = await stableSwap.getBaseOut(inUsdc);
                await expect(callBuy(inUsdc, outQ.add(1))).to.be.revertedWith(
                    "Insufficient output"
                );
                await callBuy(inUsdc, outQ);
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
                callSwap(amountOut, maxAmountIn, [usdc.address, tokenB.address], [0]);
            const callSell = (amountOut: BigNumberish, maxAmountIn: BigNumberish) =>
                callSwap(amountOut, maxAmountIn, [tokenB.address, usdc.address], [0]);

            it("Should reject invalid path or versions", async function () {
                await expect(callSwap(0, 0, [usdc.address], [0])).to.be.revertedWith(
                    "Invalid path"
                );
                await expect(callSwap(0, 0, [tokenB.address, usdc.address], [])).to.be.revertedWith(
                    "Invalid versions"
                );
                await expect(callSwap(0, 0, [addr1, usdc.address], [0])).to.be.revertedWith(
                    "Unknown swap"
                );
            });

            it("Should transfer base tokens", async function () {
                // Sell
                const outUsdc = parseUsdc("0.123");
                const inQ = await stableSwap.getBaseIn(outUsdc);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(() => callSell(outUsdc, parseEther("999"))).to.callMocks({
                    func: fund.mock.trancheTransferFrom.withArgs(
                        TRANCHE_B,
                        addr1,
                        stableSwap.address,
                        inQ,
                        0
                    ),
                });
                // Buy
                await expect(() => callBuy(parseEther("0.456"), parseUsdc("999"))).to.callMocks({
                    func: fund.mock.trancheTransfer.withArgs(
                        TRANCHE_B,
                        addr2,
                        parseEther("0.456"),
                        0
                    ),
                });
            });

            it("Should transfer quote tokens", async function () {
                await fund.mock.trancheTransfer.returns();
                await fund.mock.trancheTransferFrom.returns();
                // Sell
                const outUsdc = parseUsdc("0.123");
                const inQ = await stableSwap.getBaseIn(outUsdc);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(() => callSell(outUsdc, parseEther("999"))).to.changeTokenBalances(
                    usdc,
                    [user2, stableSwap],
                    [outUsdc, outUsdc.mul(-1)]
                );
                // Buy
                const outQ = parseEther("0.456");
                const inUsdc = await stableSwap.getQuoteIn(outQ);
                await expect(() => callBuy(outQ, parseUsdc("999"))).to.changeTokenBalances(
                    usdc,
                    [user1, stableSwap],
                    [inUsdc.mul(-1), inUsdc]
                );
            });

            it("Should check max input", async function () {
                await fund.mock.trancheTransfer.returns();
                await fund.mock.trancheTransferFrom.returns();
                // Sell
                const outUsdc = parseUsdc("0.123");
                const inQ = await stableSwap.getBaseIn(outUsdc);
                await addBase(inQ); // Mock effect of the base token transfer
                await expect(callSell(outUsdc, inQ.sub(1))).to.be.revertedWith("Excessive input");
                await callSell(outUsdc, inQ.mul(10));
                // Buy
                const outQ = parseEther("0.456");
                const inUsdc = await stableSwap.getQuoteIn(outQ);
                await expect(callBuy(outQ, inUsdc.sub(1))).to.be.revertedWith("Excessive input");
                await callBuy(outQ, inUsdc);
            });
        });
    });

    describe("Rebalance", function () {
        const excessiveQ = parseEther("1");
        let primaryMarket: MockContract;

        this.beforeEach(async function () {
            primaryMarket = await deployMockForName(owner, "IPrimaryMarketV3");
            await fund.mock.getRebalanceSize.returns(1);
            await fund.mock.primaryMarket.returns(primaryMarket.address);
        });

        it("Should handle lower rebalance with less BISHOP after split", async function () {
            const afterSplitB = INIT_B.div(4);
            const splittedB = INIT_B.div(8);
            const afterRebalanceQuote = INIT_USDC.mul(afterSplitB.add(splittedB)).div(INIT_B);
            await fund.mock.trancheBalanceOf
                .withArgs(TRANCHE_B, stableSwap.address)
                .returns(afterSplitB.add(splittedB));
            await expect(() => stableSwap.sync()).to.callMocks(
                {
                    func: fund.mock.batchRebalance.withArgs(0, INIT_B, 0, 0, 1),
                    rets: [excessiveQ, afterSplitB, 0],
                },
                {
                    func: primaryMarket.mock.getSplit.withArgs(excessiveQ),
                    rets: [splittedB],
                },
                {
                    func: primaryMarket.mock.split.withArgs(stableSwap.address, excessiveQ, 1),
                    rets: [splittedB],
                },
                {
                    func: fund.mock.trancheTransfer.withArgs(
                        TRANCHE_R,
                        lpToken.address,
                        splittedB,
                        1
                    ),
                }
            );
            const dist1 = await lpToken.distributions(1);
            const totalSupply1 = await lpToken.distributionTotalSupplies(1);
            expect(dist1.amountQ).to.equal(0);
            expect(dist1.amountB).to.equal(0);
            expect(dist1.amountR).to.equal(splittedB);
            expect(dist1.quoteAmount).to.equal(INIT_USDC.sub(afterRebalanceQuote));
            expect(totalSupply1).to.equal(await lpToken.totalSupply());
        });

        it("Should handle lower rebalance with more BISHOP after split", async function () {
            const afterSplitB = INIT_B.div(8);
            const splittedB = INIT_B;
            await fund.mock.trancheBalanceOf
                .withArgs(TRANCHE_B, stableSwap.address)
                .returns(afterSplitB.add(splittedB));
            await expect(() => stableSwap.sync()).to.callMocks(
                {
                    func: fund.mock.batchRebalance.withArgs(0, INIT_B, 0, 0, 1),
                    rets: [excessiveQ, afterSplitB, 0],
                },
                {
                    func: primaryMarket.mock.getSplit.withArgs(excessiveQ),
                    rets: [splittedB],
                },
                {
                    func: primaryMarket.mock.split.withArgs(stableSwap.address, excessiveQ, 1),
                    rets: [splittedB],
                },
                {
                    func: fund.mock.trancheTransfer.withArgs(
                        TRANCHE_B,
                        lpToken.address,
                        afterSplitB.add(splittedB).sub(INIT_B),
                        1
                    ),
                },
                {
                    func: fund.mock.trancheTransfer.withArgs(
                        TRANCHE_R,
                        lpToken.address,
                        splittedB,
                        1
                    ),
                }
            );
            const dist1 = await lpToken.distributions(1);
            const totalSupply1 = await lpToken.distributionTotalSupplies(1);
            expect(dist1.amountQ).to.equal(0);
            expect(dist1.amountB).to.equal(afterSplitB.add(splittedB).sub(INIT_B));
            expect(dist1.amountR).to.equal(splittedB);
            expect(dist1.quoteAmount).to.equal(0);
            expect(totalSupply1).to.equal(await lpToken.totalSupply());
        });

        it("Should handle upper rebalance", async function () {
            await fund.mock.trancheBalanceOf
                .withArgs(TRANCHE_B, stableSwap.address)
                .returns(INIT_B);
            await expect(() => stableSwap.sync()).to.callMocks(
                {
                    func: fund.mock.batchRebalance.withArgs(0, INIT_B, 0, 0, 1),
                    rets: [excessiveQ, INIT_B, 0],
                },
                {
                    func: fund.mock.trancheTransfer.withArgs(
                        TRANCHE_Q,
                        lpToken.address,
                        excessiveQ,
                        1
                    ),
                }
            );
            const dist1 = await lpToken.distributions(1);
            const totalSupply1 = await lpToken.distributionTotalSupplies(1);
            expect(dist1.amountQ).to.equal(excessiveQ);
            expect(dist1.amountB).to.equal(0);
            expect(dist1.amountR).to.equal(0);
            expect(dist1.quoteAmount).to.equal(0);
            expect(totalSupply1).to.equal(await lpToken.totalSupply());
        });
    });
});
