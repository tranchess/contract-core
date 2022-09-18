import { expect } from "chai";
import { BigNumber, BigNumberish, constants, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import { TRANCHE_Q, TRANCHE_B, TRANCHE_R, DAY, FixtureWalletMap } from "./utils";

const BTC_TO_ETHER = parseUnits("1", 10);
const REDEMPTION_FEE_BPS = 35;
const MERGE_FEE_BPS = 45;

const TOTAL_UNDERLYING = parseBtc("10");
const EQUIVALENT_TOTAL_Q = parseEther("10000");
const SPLIT_RATIO = parseEther("400");

describe("PrimaryMarketV4", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly btc: Contract;
        readonly twapOracle: MockContract;
        readonly fund: Contract;
        readonly primaryMarket: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let addr1: string;
    let addr2: string;
    let owner: Wallet;
    let btc: Contract;
    let twapOracle: MockContract;
    let fund: Contract;
    let primaryMarket: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        const fund = await deployMockForName(owner, "FundV4");
        await fund.mock.twapOracle.returns(twapOracle.address);
        await fund.mock.tokenUnderlying.returns(btc.address);
        await fund.mock.underlyingDecimalMultiplier.returns(1e10);
        await fund.mock.getTotalUnderlying.returns(TOTAL_UNDERLYING);
        await fund.mock.getEquivalentTotalQ.returns(EQUIVALENT_TOTAL_Q);
        await fund.mock.splitRatio.returns(SPLIT_RATIO);
        await btc.mint(fund.address, TOTAL_UNDERLYING);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV4");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
            parseEther("0.0001").mul(MERGE_FEE_BPS),
            BigNumber.from(1).shl(256).sub(1),
            true
        );

        return {
            wallets: { user1, user2, owner },
            btc,
            twapOracle,
            fund,
            primaryMarket: primaryMarket.connect(user1),
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
        owner = fixtureData.wallets.owner;
        btc = fixtureData.btc;
        twapOracle = fixtureData.twapOracle;
        fund = fixtureData.fund;
        primaryMarket = fixtureData.primaryMarket;
    });

    describe("create()", function () {
        const inBtc = parseBtc("1");
        const outQ = inBtc.mul(EQUIVALENT_TOTAL_Q).div(TOTAL_UNDERLYING);

        it("Should transfer underlying to fund", async function () {
            await fund.mock.primaryMarketMint.returns();
            await btc.mint(primaryMarket.address, inBtc);
            await expect(() => primaryMarket.create(addr2, 0, 0)).to.changeTokenBalances(
                btc,
                [primaryMarket, fund],
                [inBtc.mul(-1), inBtc]
            );
        });

        it("Should mint QUEEN to the given recipient", async function () {
            const version = 999;
            await btc.mint(primaryMarket.address, inBtc);
            await expect(() => primaryMarket.create(addr2, 0, version)).to.callMocks({
                func: fund.mock.primaryMarketMint.withArgs(TRANCHE_Q, addr2, outQ, version),
            });
        });

        it("Should return created QUEEN amount", async function () {
            await fund.mock.primaryMarketMint.returns();
            await btc.mint(primaryMarket.address, inBtc);
            expect(await primaryMarket.callStatic.create(addr2, 0, 0)).to.equal(outQ);
        });

        it("Should check min QUEEN created", async function () {
            await fund.mock.primaryMarketMint.returns();
            await btc.mint(primaryMarket.address, inBtc);
            await expect(primaryMarket.create(addr2, outQ.add(1), 0)).to.be.revertedWith(
                "Min QUEEN created"
            );
            await primaryMarket.create(addr2, outQ, 0);
        });

        it("Should revert if no QUEEN can be created", async function () {
            await expect(primaryMarket.create(addr2, 0, 0)).to.be.revertedWith("Min QUEEN created");

            await fund.mock.getEquivalentTotalQ.returns(1);
            await fund.mock.getTotalUnderlying.returns(parseBtc("10"));
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await expect(primaryMarket.create(addr2, 0, 0)).to.be.revertedWith("Min QUEEN created");
        });

        it("Should check fund cap", async function () {
            await fund.mock.primaryMarketMint.returns();
            await primaryMarket.connect(owner).updateFundCap(TOTAL_UNDERLYING.add(inBtc).sub(1));
            await btc.mint(primaryMarket.address, inBtc);
            await expect(primaryMarket.create(addr2, 0, 0)).to.be.revertedWith("Exceed fund cap");
            await primaryMarket.connect(owner).updateFundCap(TOTAL_UNDERLYING.add(inBtc));
            await primaryMarket.create(addr2, 0, 0);
        });

        it("Should revert if the fund is not initialized", async function () {
            await fund.mock.getEquivalentTotalQ.returns(0);
            await fund.mock.splitRatio.returns(0);
            await btc.mint(primaryMarket.address, inBtc);
            await expect(primaryMarket.create(addr2, 0, 0)).to.be.revertedWith(
                "Fund is not initialized"
            );
        });

        it("Should create using split ratio when fund was empty", async function () {
            await fund.mock.getEquivalentTotalQ.returns(0);
            await fund.mock.getTotalUnderlying.returns(parseBtc("10")); // underlying can be non-zero
            const currentDay = 1609556400; // 2021-01-02 03:00:00
            await fund.mock.currentDay.returns(currentDay);
            await twapOracle.mock.getTwap.withArgs(currentDay - DAY).returns(parseEther("1000"));
            const navB = parseEther("1.2");
            const navR = parseEther("1.8");
            await fund.mock.historicalNavs.withArgs(currentDay - DAY).returns(navB, navR);
            await fund.mock.primaryMarketMint.returns();
            await btc.mint(primaryMarket.address, inBtc);
            expect(await primaryMarket.callStatic.create(addr2, 0, 0)).equal(
                inBtc
                    .mul(BTC_TO_ETHER)
                    .mul(parseEther("1000"))
                    .div(SPLIT_RATIO)
                    .mul(parseEther("1"))
                    .div(navB.add(navR))
            );
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketMint.returns();
            await btc.mint(primaryMarket.address, inBtc);
            await expect(primaryMarket.create(addr2, 0, 0))
                .to.emit(primaryMarket, "Created")
                .withArgs(addr2, inBtc, outQ);
        });
    });

    describe("redeem()", function () {
        const inQ = parseEther("1");
        const feeQ = inQ.mul(REDEMPTION_FEE_BPS).div(10000);
        const outBtc = inQ.sub(feeQ).mul(TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_Q);

        it("Should burn QUEEN and transfer underlying", async function () {
            const version = 999;
            await expect(() => primaryMarket.redeem(addr2, inQ, 0, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_Q, addr1, inQ, version),
                },
                {
                    func: fund.mock.primaryMarketTransferUnderlying.withArgs(addr2, outBtc, feeQ),
                }
            );
        });

        it("Should return redeemed underlying amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            expect(await primaryMarket.callStatic.redeem(addr2, inQ, 0, 0)).to.equal(outBtc);
        });

        it("Should check min underlying redeemed", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            await expect(primaryMarket.redeem(addr2, inQ, outBtc.add(1), 0)).to.be.revertedWith(
                "Min underlying redeemed"
            );
            await primaryMarket.redeem(addr2, inQ, outBtc, 0);
        });

        it("Should revert if no underlying can be redeemed", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            await fund.mock.getEquivalentTotalQ.returns(parseEther("10000"));
            await fund.mock.getTotalUnderlying.returns(1);
            await expect(primaryMarket.redeem(addr2, 1, 0, 0)).to.be.revertedWith(
                "Min underlying redeemed"
            );
        });

        it("Should revert on not enough available hot balance", async function () {
            await btc.burn(fund.address, TOTAL_UNDERLYING);
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();

            await btc.mint(fund.address, outBtc.sub(1));
            await expect(primaryMarket.redeem(addr2, inQ, 0, 0)).to.be.revertedWith(
                "Not enough underlying in fund"
            );
            await btc.mint(fund.address, 1);
            await primaryMarket.redeem(addr2, inQ, 0, 0);
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            await expect(primaryMarket.redeem(addr2, inQ, outBtc, 0))
                .to.emit(primaryMarket, "Redeemed")
                .withArgs(addr2, inQ, outBtc, feeQ);
        });
    });

    describe("split()", function () {
        const inQ = parseEther("10");
        const outB = inQ.mul(SPLIT_RATIO).div(parseEther("1"));

        it("Should burn and mint tranche tokens and add fee debt", async function () {
            const version = 999;
            await expect(() => primaryMarket.split(addr2, inQ, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_Q, addr1, inQ, version),
                },
                {
                    func: fund.mock.primaryMarketMint.withArgs(TRANCHE_B, addr2, outB, version),
                },
                {
                    func: fund.mock.primaryMarketMint.withArgs(TRANCHE_R, addr2, outB, version),
                }
            );
        });

        it("Should return split amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            expect(await primaryMarket.callStatic.split(addr2, 0, 0)).to.equal(0);
            expect(await primaryMarket.callStatic.split(addr2, inQ, 0)).to.equal(outB);
        });

        it("Should round down the result", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await fund.mock.splitRatio.returns(parseEther("1.5"));
            expect(await primaryMarket.callStatic.split(addr2, 1, 0)).to.equal(1);
            expect(await primaryMarket.callStatic.split(addr2, 5, 0)).to.equal(7);
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await expect(primaryMarket.split(addr2, inQ, 0))
                .to.emit(primaryMarket, "Split")
                .withArgs(addr2, inQ, outB, outB);
        });
    });

    describe("merge()", function () {
        const inB = parseEther("10");
        const outQBeforeFee = inB.mul(parseEther("1")).div(SPLIT_RATIO);
        const feeQ = outQBeforeFee.mul(MERGE_FEE_BPS).div(10000);
        const outQ = outQBeforeFee.sub(feeQ);

        it("Should burn and mint tranche tokens and add fee debt", async function () {
            const version = 999;
            await expect(() => primaryMarket.merge(addr2, inB, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_B, addr1, inB, version),
                },
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_R, addr1, inB, version),
                },
                {
                    func: fund.mock.primaryMarketMint.withArgs(TRANCHE_Q, addr2, outQ, version),
                },
                {
                    func: fund.mock.primaryMarketAddDebtAndFee.withArgs(0, feeQ),
                }
            );
        });

        it("Should return merged amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            expect(await primaryMarket.callStatic.merge(addr2, 0, 0)).to.equal(0);
            expect(await primaryMarket.callStatic.merge(addr2, inB, 0)).to.equal(outQ);
        });

        it("Should round down the result", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await fund.mock.splitRatio.returns(parseEther("1.5"));
            expect(await primaryMarket.callStatic.merge(addr2, 4, 0)).to.equal(2);
            expect(await primaryMarket.callStatic.merge(addr2, 8, 0)).to.equal(5);
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await expect(primaryMarket.merge(addr2, inB, 0))
                .to.emit(primaryMarket, "Merged")
                .withArgs(addr2, outQ, inB, inB, feeQ);
        });
    });

    describe("queueRedemption()", function () {
        const inQ = parseEther("1");
        const feeQ = inQ.mul(REDEMPTION_FEE_BPS).div(10000);
        const outBtc = inQ.sub(feeQ).mul(TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_Q);

        it("Should burn QUEEN and add debt", async function () {
            const version = 999;
            await expect(() => primaryMarket.queueRedemption(addr2, inQ, 0, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_Q, addr1, inQ, version),
                },
                {
                    func: fund.mock.primaryMarketAddDebtAndFee.withArgs(outBtc, feeQ),
                }
            );
        });

        it("Should return redeemed underlying amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            const ret = await primaryMarket.callStatic.queueRedemption(addr2, inQ, 0, 0);
            expect(ret.underlying).to.equal(outBtc);
        });

        it("Should check min underlying redeemed", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await expect(
                primaryMarket.queueRedemption(addr2, inQ, outBtc.add(1), 0)
            ).to.be.revertedWith("Min underlying redeemed");
            await primaryMarket.queueRedemption(addr2, inQ, outBtc, 0);
        });

        it("Should revert if no underlying can be redeemed", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await fund.mock.getEquivalentTotalQ.returns(parseEther("10000"));
            await fund.mock.getTotalUnderlying.returns(1);
            await expect(primaryMarket.queueRedemption(addr2, 1, 0, 0)).to.be.revertedWith(
                "Min underlying redeemed"
            );
        });

        it("Should return index in the queue", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            const ret0 = await primaryMarket.callStatic.queueRedemption(addr2, inQ, 0, 0);
            expect(ret0.index).to.equal(0);
            await primaryMarket.queueRedemption(addr2, inQ, 0, 0);
            await primaryMarket.queueRedemption(addr2, inQ, 0, 0);
            const ret1 = await primaryMarket.callStatic.queueRedemption(addr2, inQ, 0, 0);
            expect(ret1.index).to.equal(2);
        });

        it("Should append redemption to the queue", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();

            await primaryMarket.queueRedemption(addr2, inQ, 0, 0);
            expect(await primaryMarket.redemptionQueueTail()).to.equal(1);
            const redemption0 = await primaryMarket.queuedRedemptions(0);
            expect(redemption0.account).to.equal(addr2);
            expect(redemption0.underlying).to.equal(outBtc);
            expect(redemption0.previousPrefixSum).to.equal(0);
            expect((await primaryMarket.queuedRedemptions(1)).previousPrefixSum).to.equal(outBtc);

            await primaryMarket.queueRedemption(addr1, inQ.mul(2), 0, 0);
            expect(await primaryMarket.redemptionQueueTail()).to.equal(2);
            const redemption1 = await primaryMarket.queuedRedemptions(1);
            expect(redemption1.account).to.equal(addr1);
            expect(redemption1.underlying).to.equal(outBtc.mul(2));
            expect(redemption1.previousPrefixSum).to.equal(outBtc);
            expect((await primaryMarket.queuedRedemptions(2)).previousPrefixSum).to.equal(
                outBtc.mul(3)
            );
        });

        it("Should emit Redeemed event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await expect(primaryMarket.queueRedemption(addr2, inQ, outBtc, 0))
                .to.emit(primaryMarket, "Redeemed")
                .withArgs(addr2, inQ, outBtc, feeQ);
        });

        it("Should emit RedemptionQueued event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await primaryMarket.queueRedemption(addr2, inQ.mul(2), 0, 0);
            await expect(primaryMarket.queueRedemption(addr2, inQ, 0, 0))
                .to.emit(primaryMarket, "RedemptionQueued")
                .withArgs(addr2, 1, outBtc);
        });
    });

    describe("Redemption queue", function () {
        const outBtcList: BigNumber[] = [];
        const outPrefixSum: BigNumber[] = [];

        beforeEach(async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await btc.burn(fund.address, TOTAL_UNDERLYING); // Remove all underlying from the fund
            const inputList = [
                { addr: addr2, inQ: parseEther("1") },
                { addr: addr1, inQ: parseEther("3") },
                { addr: addr2, inQ: parseEther("12") },
                { addr: addr2, inQ: parseEther("7") },
            ];
            let sum = BigNumber.from(0);
            outBtcList.length = 0; // clear the array
            outPrefixSum.length = 0; // clear the array
            for (const { addr, inQ } of inputList) {
                await primaryMarket.queueRedemption(addr, inQ, 0, 0);
                const feeBtc = inQ
                    .mul(TOTAL_UNDERLYING)
                    .div(EQUIVALENT_TOTAL_Q)
                    .mul(REDEMPTION_FEE_BPS)
                    .div(10000);
                const outBtc = inQ.mul(TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_Q).sub(feeBtc);
                outBtcList.push(outBtc);
                sum = sum.add(outBtc);
                outPrefixSum.push(sum);
            }
        });

        describe("getNewRedemptionQueueHead()", function () {
            it("Should return the old head when no underlying is available", async function () {
                expect(await primaryMarket.getNewRedemptionQueueHead()).to.equal(0);
            });

            it("Should return the correct new head", async function () {
                await btc.mint(fund.address, outPrefixSum[2]);
                expect(await primaryMarket.getNewRedemptionQueueHead()).to.equal(3);
                await btc.mint(fund.address, outPrefixSum[3].mul(100));
                expect(await primaryMarket.getNewRedemptionQueueHead()).to.equal(4);
            });
        });

        describe("getQueuedRedemptions()", function () {
            async function getQueuedRedemptions(
                addr: string | null,
                startIndex: BigNumberish,
                maxIterationCount: BigNumberish
            ): Promise<{ indices: number[]; underlying: BigNumber }> {
                const ret = await primaryMarket.getQueuedRedemptions(
                    addr ?? ethers.constants.AddressZero,
                    startIndex,
                    maxIterationCount
                );
                return {
                    indices: ret.indices.map((x: BigNumber) => x.toNumber()),
                    underlying: ret.underlying,
                };
            }

            it("Should return a slice of the queue", async function () {
                expect(await getQueuedRedemptions(null, 0, 0)).to.eql({
                    indices: [0, 1, 2, 3],
                    underlying: outPrefixSum[3],
                });
                expect(await getQueuedRedemptions(null, 1, 0)).to.eql({
                    indices: [1, 2, 3],
                    underlying: outBtcList[1].add(outBtcList[2]).add(outBtcList[3]),
                });
                expect(await getQueuedRedemptions(null, 1, 2)).to.eql({
                    indices: [1, 2],
                    underlying: outBtcList[1].add(outBtcList[2]),
                });
                expect(await getQueuedRedemptions(null, 1, 100)).to.eql({
                    indices: [1, 2, 3],
                    underlying: outBtcList[1].add(outBtcList[2]).add(outBtcList[3]),
                });
                expect(await getQueuedRedemptions(null, 4, 0)).to.eql({
                    indices: [],
                    underlying: BigNumber.from(0),
                });
            });

            it("Should filter by address", async function () {
                expect(await getQueuedRedemptions(addr1, 0, 0)).to.eql({
                    indices: [1],
                    underlying: outBtcList[1],
                });
                expect(await getQueuedRedemptions(addr1, 0, 1)).to.eql({
                    indices: [],
                    underlying: BigNumber.from(0),
                });
                expect(await getQueuedRedemptions(addr2, 0, 0)).to.eql({
                    indices: [0, 2, 3],
                    underlying: outBtcList[0].add(outBtcList[2]).add(outBtcList[3]),
                });
                expect(await getQueuedRedemptions(addr2, 0, 3)).to.eql({
                    indices: [0, 2],
                    underlying: outBtcList[0].add(outBtcList[2]),
                });
                expect(await getQueuedRedemptions(addr2, 1, 100)).to.eql({
                    indices: [2, 3],
                    underlying: outBtcList[2].add(outBtcList[3]),
                });
                expect(await getQueuedRedemptions(owner.address, 0, 0)).to.eql({
                    indices: [],
                    underlying: BigNumber.from(0),
                });
            });

            it("Should revert if start index is out of bound", async function () {
                await expect(getQueuedRedemptions(null, 5, 0)).to.be.revertedWith(
                    "startIndex out of bound"
                );
            });
        });

        describe("popRedemptionQueue()", function () {
            it("Should revert if there's no enough balance in fund", async function () {
                await expect(primaryMarket.popRedemptionQueue(1)).to.be.revertedWith(
                    "Not enough underlying in fund"
                );
                await btc.mint(fund.address, outPrefixSum[1].sub(1));
                await expect(primaryMarket.popRedemptionQueue(2)).to.be.revertedWith(
                    "Not enough underlying in fund"
                );
            });

            it("Should call fund to pay debt", async function () {
                await btc.mint(fund.address, outPrefixSum[1]);
                await expect(() => primaryMarket.popRedemptionQueue(2)).to.callMocks({
                    func: fund.mock.primaryMarketPayDebt.withArgs(outPrefixSum[1]),
                });
            });

            it("Should revert if count is out of bound", async function () {
                await fund.mock.primaryMarketPayDebt.returns();
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await expect(primaryMarket.popRedemptionQueue(9)).to.be.revertedWith(
                    "Redemption queue out of bound"
                );
                await primaryMarket.popRedemptionQueue(1);
                await expect(primaryMarket.popRedemptionQueue(4)).to.be.revertedWith(
                    "Redemption queue out of bound"
                );
                await primaryMarket.popRedemptionQueue(3);
            });

            it("Should update queue head and keep entries unchanged", async function () {
                await fund.mock.primaryMarketPayDebt.returns();
                await btc.mint(fund.address, outPrefixSum[1]);
                await primaryMarket.popRedemptionQueue(2);
                expect(await primaryMarket.redemptionQueueHead()).to.equal(2);
                expect(await primaryMarket.redemptionQueueTail()).to.equal(4);
                const redemption0 = await primaryMarket.queuedRedemptions(0);
                expect(redemption0.account).to.equal(addr2);
                expect(redemption0.underlying).to.equal(outBtcList[0]);
                expect(redemption0.previousPrefixSum).to.equal(0);
                const redemption1 = await primaryMarket.queuedRedemptions(1);
                expect(redemption1.account).to.equal(addr1);
                expect(redemption1.underlying).to.equal(outBtcList[1]);
                expect(redemption1.previousPrefixSum).to.equal(outPrefixSum[0]);
                const redemption2 = await primaryMarket.queuedRedemptions(2);
                expect(redemption2.account).to.equal(addr2);
                expect(redemption2.underlying).to.equal(outBtcList[2]);
                expect(redemption2.previousPrefixSum).to.equal(outPrefixSum[1]);
            });

            it("Should update total claimable amount", async function () {
                await fund.mock.primaryMarketPayDebt.returns();
                await btc.mint(fund.address, outPrefixSum[1]);
                await primaryMarket.popRedemptionQueue(2);
                expect(await primaryMarket.claimableUnderlying()).to.equal(outPrefixSum[1]);
            });

            it("Should clear the queue if count is zero", async function () {
                await fund.mock.primaryMarketPayDebt.returns();
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await primaryMarket.popRedemptionQueue(0);
                expect(await primaryMarket.redemptionQueueHead()).to.equal(4);
                expect(await primaryMarket.redemptionQueueTail()).to.equal(4);
                await primaryMarket.popRedemptionQueue(0);
                expect(await primaryMarket.redemptionQueueHead()).to.equal(4);
                expect(await primaryMarket.redemptionQueueTail()).to.equal(4);
                expect(await primaryMarket.getNewRedemptionQueueHead()).to.equal(4);
            });

            it("Should emit an event", async function () {
                await fund.mock.primaryMarketPayDebt.returns();
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await expect(primaryMarket.popRedemptionQueue(2))
                    .to.emit(primaryMarket, "RedemptionPopped")
                    .withArgs(2, 2, outPrefixSum[1]);
                await expect(primaryMarket.popRedemptionQueue(2))
                    .to.emit(primaryMarket, "RedemptionPopped")
                    .withArgs(2, 4, outPrefixSum[3].sub(outPrefixSum[1]));
            });
        });

        describe("claimRedemptions()", async function () {
            beforeEach(async function () {
                await fund.mock.primaryMarketPayDebt.returns();
            });

            it("Should revert if account and indices do not match", async function () {
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await expect(primaryMarket.claimRedemptions(addr1, [0])).to.be.revertedWith(
                    "Invalid redemption index"
                );
                await expect(primaryMarket.claimRedemptions(addr1, [0, 1])).to.be.revertedWith(
                    "Invalid redemption index"
                );
                await expect(primaryMarket.claimRedemptions(addr2, [0, 1])).to.be.revertedWith(
                    "Invalid redemption index"
                );
            });

            it("Should require indices to be in increasing order", async function () {
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await expect(primaryMarket.claimRedemptions(addr2, [2, 0])).to.be.revertedWith(
                    "Indices out of order"
                );
                await expect(primaryMarket.claimRedemptions(addr2, [0, 3, 2])).to.be.revertedWith(
                    "Indices out of order"
                );
            });

            it("Should revert if there's no enough balance in fund", async function () {
                await btc.mint(fund.address, outPrefixSum[2].sub(1));
                await expect(primaryMarket.claimRedemptions(addr2, [0, 2])).to.be.revertedWith(
                    "Not enough underlying in fund"
                );
            });

            it("Should transfer underlying and return claimed amount", async function () {
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await btc.mint(primaryMarket.address, TOTAL_UNDERLYING);

                const amount1 = outBtcList[1];
                expect(await primaryMarket.callStatic.claimRedemptions(addr1, [1])).to.equal(
                    amount1
                );
                await expect(() =>
                    primaryMarket.claimRedemptions(addr1, [1])
                ).to.changeTokenBalances(btc, [user1, primaryMarket], [amount1, amount1.mul(-1)]);

                const amount2 = outBtcList[0].add(outBtcList[3]);
                expect(await primaryMarket.callStatic.claimRedemptions(addr2, [0, 3])).to.equal(
                    amount2
                );
                await expect(() =>
                    primaryMarket.claimRedemptions(addr2, [0, 3])
                ).to.changeTokenBalances(btc, [user2, primaryMarket], [amount2, amount2.mul(-1)]);
            });

            it("Should update redemption queue head and delete redemptions", async function () {
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await btc.mint(primaryMarket.address, TOTAL_UNDERLYING);

                await primaryMarket.claimRedemptions(addr1, [1]);
                expect(await primaryMarket.redemptionQueueHead()).to.equal(2);
                const redemption1 = await primaryMarket.queuedRedemptions(1);
                expect(redemption1.account).to.equal(ethers.constants.AddressZero);
                expect(redemption1.underlying).to.equal(0);
                expect(redemption1.previousPrefixSum).to.equal(0);

                await primaryMarket.claimRedemptions(addr2, [0, 3]);
                expect(await primaryMarket.redemptionQueueHead()).to.equal(4);
                const redemption0 = await primaryMarket.queuedRedemptions(0);
                expect(redemption0.account).to.equal(ethers.constants.AddressZero);
                expect(redemption0.underlying).to.equal(0);
                expect(redemption0.previousPrefixSum).to.equal(0);
                const redemption3 = await primaryMarket.queuedRedemptions(3);
                expect(redemption3.account).to.equal(ethers.constants.AddressZero);
                expect(redemption3.underlying).to.equal(0);
                expect(redemption3.previousPrefixSum).to.equal(0);
            });

            it("Should update total claimable amount", async function () {
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await btc.mint(primaryMarket.address, TOTAL_UNDERLYING);

                await primaryMarket.claimRedemptions(addr1, [1]);
                expect(await primaryMarket.claimableUnderlying()).to.equal(outBtcList[0]);

                await primaryMarket.claimRedemptions(addr2, [0, 3]);
                expect(await primaryMarket.claimableUnderlying()).to.equal(outBtcList[2]);
            });

            it("Should do nothing if the index array is empty", async function () {
                expect(await primaryMarket.callStatic.claimRedemptions(addr1, [])).to.equal(0);
                await expect(() => primaryMarket.claimRedemptions(addr1, [])).to.changeTokenBalance(
                    btc,
                    user1,
                    0
                );
            });

            it("Should revert if already claimed", async function () {
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await btc.mint(primaryMarket.address, TOTAL_UNDERLYING);
                await primaryMarket.claimRedemptions(addr2, [2]);
                await expect(primaryMarket.claimRedemptions(addr2, [2])).to.be.revertedWith(
                    "Invalid redemption index"
                );
                await expect(primaryMarket.claimRedemptions(addr1, [0, 2, 3])).to.be.revertedWith(
                    "Invalid redemption index"
                );
            });

            it("Should emit an event for each claimed redemption", async function () {
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await btc.mint(primaryMarket.address, TOTAL_UNDERLYING);
                const tx = await primaryMarket.claimRedemptions(addr2, [2, 3]);
                const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
                const topic = primaryMarket.interface.getEventTopic("RedemptionClaimed");
                const expectedLogs = receipt.logs
                    .filter((x) => x.topics.includes(topic))
                    .map((x) => primaryMarket.interface.parseLog(x));
                expect(expectedLogs.length).to.equal(2);
                expect(expectedLogs[0].args.account).to.equal(addr2);
                expect(expectedLogs[0].args.index).to.equal(2);
                expect(expectedLogs[0].args.underlying).to.equal(outBtcList[2]);
                expect(expectedLogs[1].args.account).to.equal(addr2);
                expect(expectedLogs[1].args.index).to.equal(3);
                expect(expectedLogs[1].args.underlying).to.equal(outBtcList[3]);
            });
        });

        describe("redeem()", async function () {
            it("Should revert if there's no enough balance in fund", async function () {
                await btc.mint(fund.address, outPrefixSum[3].sub(1));
                await expect(primaryMarket.redeem(addr2, parseEther("1"), 0, 0)).to.be.revertedWith(
                    "Not enough underlying in fund"
                );
            });

            it("Should pop all queued redemptions", async function () {
                await btc.mint(fund.address, outPrefixSum[3]);
                await fund.mock.primaryMarketTransferUnderlying.returns();
                await expect(() => primaryMarket.redeem(addr2, parseEther("1"), 0, 0)).to.callMocks(
                    {
                        func: fund.mock.primaryMarketPayDebt.withArgs(outPrefixSum[3]),
                    }
                );
                expect(await primaryMarket.redemptionQueueHead()).to.equal(4);
                expect(await primaryMarket.claimableUnderlying()).to.equal(outPrefixSum[3]);
            });
        });

        describe("create()", function () {
            it("Should create when claimable underlying is not zero", async function () {
                await btc.mint(fund.address, outPrefixSum[3]);
                await fund.mock.primaryMarketPayDebt.returns();
                await primaryMarket.popRedemptionQueue(0);
                expect(await primaryMarket.claimableUnderlying()).to.equal(outPrefixSum[3]);
                await btc.mint(primaryMarket.address, outPrefixSum[3]);

                const inBtc = parseBtc("1");
                const outQ = inBtc.mul(EQUIVALENT_TOTAL_Q).div(TOTAL_UNDERLYING);
                await btc.mint(primaryMarket.address, inBtc);
                await fund.mock.primaryMarketMint.returns();
                expect(await primaryMarket.callStatic.create(addr2, 0, 0)).to.equal(outQ);
                await expect(() => primaryMarket.create(addr2, 0, 0)).to.changeTokenBalances(
                    btc,
                    [primaryMarket, fund],
                    [inBtc.mul(-1), inBtc]
                );
            });
        });
    });

    describe("Redemption queue prefix sum", function () {
        it("Should overflow in additions and substractions", async function () {
            await primaryMarket.connect(owner).updateRedemptionFeeRate(0);

            const BIG_UNIT = BigNumber.from(1).shl(252); // 1/16 of 2^256
            await fund.mock.getTotalUnderlying.returns(BIG_UNIT.mul(3));
            await fund.mock.getEquivalentTotalQ.returns(3);
            await btc.burn(fund.address, TOTAL_UNDERLYING); // clear btc minted before

            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 3
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 6
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 9
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 12
            await primaryMarket.queueRedemption(addr2, 2, 0, 0); // prefix sum: 14
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 1 (overflow)
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 4
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 7
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 10
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 13
            await primaryMarket.queueRedemption(addr2, 3, 0, 0); // prefix sum: 0 (overflow)
            await primaryMarket.queueRedemption(addr2, 1, 0, 0); // prefix sum: 1

            // Check overflow in additions
            const getPreviousPrefixSum = async (index: number) =>
                (await primaryMarket.queuedRedemptions(index)).previousPrefixSum;
            expect(await getPreviousPrefixSum(5)).to.equal(BIG_UNIT.mul(14));
            expect(await getPreviousPrefixSum(6)).to.equal(BIG_UNIT);
            expect(await getPreviousPrefixSum(11)).to.equal(0);
            expect(await getPreviousPrefixSum(12)).to.equal(BIG_UNIT);

            // Check overflow in substractions
            await btc.mint(fund.address, BIG_UNIT.mul(14));
            await expect(() => primaryMarket.popRedemptionQueue(5)).to.callMocks({
                func: fund.mock.primaryMarketPayDebt.withArgs(BIG_UNIT.mul(14)),
            });
            await btc.burn(fund.address, BIG_UNIT.mul(14));
            await btc.mint(primaryMarket.address, BIG_UNIT.mul(14));
            await primaryMarket.claimRedemptions(addr2, [0, 1, 2, 3, 4]);
            await btc.burn(addr2, BIG_UNIT.mul(14));

            await btc.mint(fund.address, BIG_UNIT.mul(12));
            await expect(() => primaryMarket.popRedemptionQueue(4)).to.callMocks({
                func: fund.mock.primaryMarketPayDebt.withArgs(BIG_UNIT.mul(12)), // overflow 10 - 14
            });
            await btc.burn(fund.address, BIG_UNIT.mul(12));
            await btc.mint(primaryMarket.address, BIG_UNIT.mul(12));
            await primaryMarket.claimRedemptions(addr2, [5, 6, 7, 8]);
            await btc.burn(addr2, BIG_UNIT.mul(12));

            await btc.mint(fund.address, BIG_UNIT.mul(6));
            await expect(() => primaryMarket.popRedemptionQueue(2)).to.callMocks({
                func: fund.mock.primaryMarketPayDebt.withArgs(BIG_UNIT.mul(6)), // overflow 0 - 10
            });
        });
    });

    describe("Reverse getters", function () {
        it("getCreationForQ()", async function () {
            await fund.mock.getTotalUnderlying.returns(7);
            await fund.mock.getEquivalentTotalQ.returns(10);
            expect(await primaryMarket.getCreationForQ(0)).to.equal(0);
            expect(await primaryMarket.getCreationForQ(1)).to.equal(1);

            // More QUEEN can be created
            expect(await primaryMarket.getCreationForQ(6)).to.equal(5);
            expect(await primaryMarket.getCreation(5)).to.equal(7);
        });

        it("getRedemptionForUnderlying()", async function () {
            await fund.mock.getTotalUnderlying.returns(10000);
            await fund.mock.getEquivalentTotalQ.returns(7000);
            await primaryMarket.connect(owner).updateRedemptionFeeRate(parseEther("0.003"));
            expect(await primaryMarket.getRedemptionForUnderlying(0)).to.equal(0);
            expect(await primaryMarket.getRedemptionForUnderlying(997)).to.equal(700);

            // Less QUEEN can be redeemed, i.e. suboptimal solution
            expect(await primaryMarket.getRedemptionForUnderlying(1423)).to.equal(1000);
            expect((await primaryMarket.getRedemption(999)).underlying).to.equal(1424);
        });

        it("getSplitForB()", async function () {
            await fund.mock.splitRatio.returns(parseEther("1.5"));
            expect(await primaryMarket.getSplitForB(0)).to.equal(0);
            expect(await primaryMarket.getSplitForB(1)).to.equal(1);
            expect(await primaryMarket.getSplitForB(2)).to.equal(2);
            expect(await primaryMarket.getSplitForB(5)).to.equal(4);
            expect(await primaryMarket.getSplitForB(parseEther("3"))).to.equal(parseEther("2"));
        });

        it("getMergeForQ()", async function () {
            await fund.mock.splitRatio.returns(parseEther("0.75"));
            await primaryMarket.connect(owner).updateMergeFeeRate(parseEther("0.003"));
            expect(await primaryMarket.getMergeForQ(0)).to.equal(0);
            expect(await primaryMarket.getMergeForQ(9970)).to.equal(7500);

            // More QUEEN can be received
            expect(await primaryMarket.getMergeForQ(1000)).to.equal(753);
            expect((await primaryMarket.getMerge(753)).outQ).to.equal(1001);

            // Less BISHOP/ROOK can be spent, i.e. suboptimal solution
            expect(await primaryMarket.getMergeForQ(665)).to.equal(501);
            expect((await primaryMarket.getMerge(500)).outQ).to.equal(665);
        });
    });

    describe("Wrapped native currency", function () {
        const ETH_TOTAL_UNDERLYING = parseEther("10");
        let weth: Contract;

        beforeEach(async function () {
            const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
            weth = await MockWrappedToken.connect(owner).deploy("Wrapped ETH", "ETH");
            weth = weth.connect(user1);
            await fund.mock.tokenUnderlying.returns(weth.address);
            await fund.mock.getTotalUnderlying.returns(ETH_TOTAL_UNDERLYING);
            await fund.mock.getEquivalentTotalQ.returns(EQUIVALENT_TOTAL_Q);
            const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV4");
            primaryMarket = await PrimaryMarket.connect(owner).deploy(
                fund.address,
                parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
                parseEther("0.0001").mul(MERGE_FEE_BPS),
                BigNumber.from(1).shl(256).sub(1),
                true
            );
            primaryMarket = primaryMarket.connect(user1);
        });

        it("redeemAndUnwrap()", async function () {
            const inQ = parseEther("1");
            const feeQ = inQ.mul(REDEMPTION_FEE_BPS).div(10000);
            const outEth = inQ.sub(feeQ).mul(ETH_TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_Q);
            const version = 999;
            await weth.connect(owner).deposit({ value: outEth.mul(2) });
            await weth.connect(owner).transfer(primaryMarket.address, outEth);
            await weth.connect(owner).transfer(fund.address, outEth);
            await fund.mock.primaryMarketBurn.withArgs(TRANCHE_Q, addr1, inQ, version).returns();
            await fund.mock.primaryMarketTransferUnderlying
                .withArgs(primaryMarket.address, outEth, feeQ)
                .returns();
            expect(await primaryMarket.callStatic.redeemAndUnwrap(addr2, inQ, 0, version)).to.equal(
                outEth
            );
            await expect(() =>
                primaryMarket.redeemAndUnwrap(addr2, inQ, 0, version)
            ).to.changeEtherBalance(user2, outEth);
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(0);
        });

        it("claimRedemptionsAndUnwrap()", async function () {
            const inQ = parseEther("1");
            const feeQ = inQ.mul(REDEMPTION_FEE_BPS).div(10000);
            const outEth = inQ.sub(feeQ).mul(ETH_TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_Q);
            await weth.connect(owner).deposit({ value: outEth.mul(2) });
            await weth.connect(owner).transfer(primaryMarket.address, outEth);
            await weth.connect(owner).transfer(fund.address, outEth);
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebtAndFee.returns();
            await primaryMarket.queueRedemption(addr2, inQ, 0, 0);

            await fund.mock.primaryMarketPayDebt.withArgs(outEth).returns();
            expect(await primaryMarket.callStatic.claimRedemptionsAndUnwrap(addr2, [0])).to.equal(
                outEth
            );
            await expect(() =>
                primaryMarket.claimRedemptionsAndUnwrap(addr2, [0])
            ).to.changeEtherBalance(user2, outEth);
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(0);
        });
    });

    describe("PrimaryMarketRouter", function () {
        const inBtc = parseBtc("1");
        const outQ = inBtc.mul(EQUIVALENT_TOTAL_Q).div(TOTAL_UNDERLYING);
        const outB = outQ.mul(100);
        const version = 1;
        const minLpOut = parseEther("1");

        let tokenB: MockContract;
        let primaryMarket: MockContract;
        let shareStaking: MockContract;
        let swapRouter: MockContract;
        let swap: MockContract;
        let primaryMarketRouter: Contract;

        beforeEach(async function () {
            btc = await deployMockForName(owner, "IERC20");
            tokenB = await deployMockForName(owner, "IERC20");
            await fund.mock.tokenUnderlying.returns(btc.address);
            await fund.mock.tokenB.returns(tokenB.address);

            primaryMarket = await deployMockForName(owner, "PrimaryMarketV4");
            await primaryMarket.mock.fund.returns(fund.address);

            shareStaking = await deployMockForName(owner, "ShareStaking");

            swap = await deployMockForName(owner, "StableSwap");
            swapRouter = await deployMockForName(owner, "SwapRouter");
            await swapRouter.mock.getSwap.returns(swap.address);

            const PrimaryMarketRouter = await ethers.getContractFactory("PrimaryMarketRouter");
            primaryMarketRouter = await PrimaryMarketRouter.connect(owner).deploy(
                primaryMarket.address
            );
            primaryMarketRouter = primaryMarketRouter.connect(user1);
        });

        describe("split", function () {
            beforeEach(async function () {
                await fund.mock.trancheTransferFrom
                    .withArgs(TRANCHE_Q, addr1, primaryMarketRouter.address, outQ, version)
                    .returns();
                await primaryMarket.mock.split
                    .withArgs(primaryMarketRouter.address, outQ, version)
                    .returns(outB);
            });

            it("Should revert if lp out less than minLpOut", async function () {
                await fund.mock.trancheTransfer
                    .withArgs(TRANCHE_B, swap.address, outB, version)
                    .returns();
                await swap.mock.addLiquidity.withArgs(version, addr1).returns(minLpOut);

                await expect(
                    primaryMarketRouter.splitAndStake(
                        outQ,
                        swapRouter.address,
                        btc.address,
                        minLpOut.add(1),
                        shareStaking.address,
                        version
                    )
                ).to.be.revertedWith("Insufficient output");
            });

            it("Should split and stake both bishop and rook", async function () {
                await expect(() =>
                    primaryMarketRouter.splitAndStake(
                        outQ,
                        swapRouter.address,
                        btc.address,
                        minLpOut,
                        shareStaking.address,
                        version
                    )
                ).to.callMocks(
                    {
                        func: fund.mock.trancheTransfer.withArgs(
                            TRANCHE_B,
                            swap.address,
                            outB,
                            version
                        ),
                    },
                    {
                        func: swap.mock.addLiquidity.withArgs(version, addr1),
                        rets: [minLpOut],
                    },
                    {
                        func: fund.mock.trancheTransfer.withArgs(
                            TRANCHE_R,
                            shareStaking.address,
                            outB,
                            version
                        ),
                    },
                    {
                        func: shareStaking.mock.deposit.withArgs(TRANCHE_R, outB, addr1, version),
                    }
                );
            });

            it("Should split and stake bishop and transfer back rook", async function () {
                await expect(() =>
                    primaryMarketRouter.splitAndStake(
                        outQ,
                        swapRouter.address,
                        btc.address,
                        minLpOut,
                        constants.AddressZero,
                        version
                    )
                ).to.callMocks(
                    {
                        func: fund.mock.trancheTransfer.withArgs(
                            TRANCHE_B,
                            swap.address,
                            outB,
                            version
                        ),
                    },
                    {
                        func: swap.mock.addLiquidity.withArgs(version, addr1),
                        rets: [minLpOut],
                    },
                    {
                        func: fund.mock.trancheTransfer.withArgs(TRANCHE_R, addr1, outB, version),
                    }
                );
            });
        });

        describe("create()", function () {
            it("Should create by calling primary market create", async function () {
                await expect(() =>
                    primaryMarketRouter.create(addr1, inBtc, outQ, version)
                ).to.callMocks(
                    {
                        func: btc.mock.transferFrom.withArgs(addr1, primaryMarket.address, inBtc),
                        rets: [true],
                    },
                    {
                        func: primaryMarket.mock.create.withArgs(addr1, outQ, version),
                        rets: [outQ],
                    }
                );
            });

            it("Should buy by calling primary market create", async function () {
                await expect(() =>
                    primaryMarketRouter.buy(version, outQ, addr1, "0x")
                ).to.callMocks(
                    {
                        func: btc.mock.balanceOf.withArgs(primaryMarketRouter.address),
                        rets: [inBtc],
                    },
                    {
                        func: btc.mock.transfer.withArgs(primaryMarket.address, inBtc),
                        rets: [true],
                    },
                    {
                        func: primaryMarket.mock.create.withArgs(addr1, outQ, version),
                        rets: [outQ],
                    }
                );
            });

            it("Should stake after creation", async function () {
                await expect(() =>
                    primaryMarketRouter.createAndStake(inBtc, outQ, shareStaking.address, version)
                ).to.callMocks(
                    {
                        func: btc.mock.transferFrom.withArgs(addr1, primaryMarket.address, inBtc),
                        rets: [true],
                    },
                    {
                        func: primaryMarket.mock.create.withArgs(
                            shareStaking.address,
                            outQ,
                            version
                        ),
                        rets: [outQ],
                    },
                    {
                        func: shareStaking.mock.deposit.withArgs(TRANCHE_Q, outQ, addr1, version),
                    }
                );
            });

            it("Should split and stake after creation", async function () {
                await expect(() =>
                    primaryMarketRouter.createSplitAndStake(
                        inBtc,
                        outQ,
                        swapRouter.address,
                        btc.address,
                        minLpOut,
                        shareStaking.address,
                        version
                    )
                ).to.callMocks(
                    {
                        func: btc.mock.transferFrom.withArgs(addr1, primaryMarket.address, inBtc),
                        rets: [true],
                    },
                    {
                        func: primaryMarket.mock.create.withArgs(
                            primaryMarketRouter.address,
                            outQ,
                            version
                        ),
                        rets: [outQ],
                    },
                    {
                        func: primaryMarket.mock.split.withArgs(
                            primaryMarketRouter.address,
                            outQ,
                            version
                        ),
                        rets: [outB],
                    },
                    {
                        func: fund.mock.trancheTransfer.withArgs(
                            TRANCHE_B,
                            swap.address,
                            outB,
                            version
                        ),
                    },
                    {
                        func: swap.mock.addLiquidity.withArgs(version, addr1),
                        rets: [minLpOut],
                    },
                    {
                        func: fund.mock.trancheTransfer.withArgs(
                            TRANCHE_R,
                            shareStaking.address,
                            outB,
                            version
                        ),
                    },
                    {
                        func: shareStaking.mock.deposit.withArgs(TRANCHE_R, outB, addr1, version),
                    }
                );
            });
        });

        describe("redeem()", function () {
            it("Should sell by calling primary market redeem", async function () {
                await expect(() =>
                    primaryMarketRouter.sell(version, inBtc, addr1, "0x")
                ).to.callMocks(
                    {
                        func: fund.mock.trancheBalanceOf.withArgs(
                            TRANCHE_Q,
                            primaryMarketRouter.address
                        ),
                        rets: [outQ],
                    },
                    {
                        func: primaryMarket.mock.redeem.withArgs(addr1, outQ, inBtc, version),
                        rets: [inBtc],
                    }
                );
            });
        });
    });
});
