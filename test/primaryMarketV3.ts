import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import { TRANCHE_M, TRANCHE_A, TRANCHE_B, DAY, FixtureWalletMap } from "./utils";

const REDEMPTION_FEE_BPS = 35;
const MERGE_FEE_BPS = 45;

const TOTAL_UNDERLYING = parseBtc("10");
const TOTAL_SHARES = parseEther("10000");

describe("PrimaryMarketV3", function () {
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
        const fund = await deployMockForName(owner, "FundV3");
        await fund.mock.tokenUnderlying.returns(btc.address);
        await fund.mock.underlyingDecimalMultiplier.returns(1e10);
        await fund.mock.isPrimaryMarketActive.returns(true);
        await fund.mock.getTotalUnderlying.returns(TOTAL_UNDERLYING);
        await fund.mock.getTotalShares.returns(TOTAL_SHARES);
        await btc.mint(fund.address, TOTAL_UNDERLYING);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
            parseEther("0.0001").mul(MERGE_FEE_BPS),
            BigNumber.from(1).shl(256).sub(1)
        );

        // Set initial state
        await btc.mint(user1.address, parseBtc("10000"));
        await btc.mint(user2.address, parseBtc("10000"));
        await btc.connect(user1).approve(primaryMarket.address, parseBtc("10000"));
        await btc.connect(user2).approve(primaryMarket.address, parseBtc("10000"));

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
        const outM = inBtc.mul(TOTAL_SHARES).div(TOTAL_UNDERLYING);

        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.create(addr1, inBtc, 0, 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should transfer underlying from msg.sender", async function () {
            await fund.mock.primaryMarketMint.returns();
            await expect(() => primaryMarket.create(addr2, inBtc, 0, 0)).to.changeTokenBalances(
                btc,
                [user1, fund],
                [inBtc.mul(-1), inBtc]
            );
        });

        it("Should mint shares to the given recipient", async function () {
            const version = 999;
            await expect(() => primaryMarket.create(addr2, inBtc, 0, version)).to.callMocks({
                func: fund.mock.primaryMarketMint.withArgs(TRANCHE_M, addr2, outM, version),
            });
        });

        it("Should return created share amount", async function () {
            await fund.mock.primaryMarketMint.returns();
            expect(await primaryMarket.callStatic.create(addr2, inBtc, 0, 0)).to.equal(outM);
        });

        it("Should check min shares created", async function () {
            await fund.mock.primaryMarketMint.returns();
            await expect(primaryMarket.create(addr2, inBtc, outM.add(1), 0)).to.be.revertedWith(
                "Min shares created"
            );
            await primaryMarket.create(addr2, inBtc, outM, 0);
        });

        it("Should revert if no share can be created", async function () {
            await fund.mock.primaryMarketMint.returns();
            await fund.mock.getTotalShares.returns(1);
            await fund.mock.getTotalUnderlying.returns(parseBtc("10"));
            await expect(primaryMarket.create(addr2, parseBtc("1"), 0, 0)).to.be.revertedWith(
                "Min shares created"
            );
        });

        it("Should check fund cap", async function () {
            await fund.mock.primaryMarketMint.returns();
            await primaryMarket.connect(owner).updateFundCap(TOTAL_UNDERLYING.add(inBtc).sub(1));
            await expect(primaryMarket.create(addr2, inBtc, 0, 0)).to.be.revertedWith(
                "Exceed fund cap"
            );
            await primaryMarket.connect(owner).updateFundCap(TOTAL_UNDERLYING.add(inBtc));
            await primaryMarket.create(addr2, inBtc, 0, 0);
        });

        it("Should create using price and NAV when fund was empty", async function () {
            // Create with 1 BTC at price 30000 and NAV 0.5
            await fund.mock.getTotalShares.returns(0);
            await fund.mock.getTotalUnderlying.returns(parseBtc("10")); // underlying can be non-zero
            const currentDay = 1609556400; // 2021-01-02 03:00:00
            await fund.mock.currentDay.returns(currentDay);
            await fund.mock.twapOracle.returns(twapOracle.address);
            await twapOracle.mock.getTwap.withArgs(currentDay - DAY).returns(parseEther("30000"));
            await fund.mock.historicalNavs
                .withArgs(currentDay - DAY)
                .returns(parseEther("0.5"), 0, 0);
            await fund.mock.primaryMarketMint.returns();
            expect(await primaryMarket.callStatic.create(addr2, inBtc, 0, 0)).equal(
                parseEther("60000")
            );
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketMint.returns();
            await expect(primaryMarket.create(addr2, inBtc, 0, 0))
                .to.emit(primaryMarket, "Created")
                .withArgs(addr2, inBtc, outM);
        });
    });

    describe("redeem()", function () {
        const inM = parseEther("1");
        const feeBtc = inM
            .mul(TOTAL_UNDERLYING)
            .div(TOTAL_SHARES)
            .mul(REDEMPTION_FEE_BPS)
            .div(10000);
        const outBtc = inM.mul(TOTAL_UNDERLYING).div(TOTAL_SHARES).sub(feeBtc);

        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.redeem(addr1, inM, 0, 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should burn shares and transfer underlying", async function () {
            const version = 999;
            await expect(() => primaryMarket.redeem(addr2, inM, 0, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_M, addr1, inM, version),
                },
                {
                    func: fund.mock.primaryMarketTransferUnderlying.withArgs(addr2, outBtc, feeBtc),
                }
            );
        });

        it("Should return redeemed underlying amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            expect(await primaryMarket.callStatic.redeem(addr2, inM, 0, 0)).to.equal(outBtc);
        });

        it("Should check min underlying redeemed", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            await expect(primaryMarket.redeem(addr2, inM, outBtc.add(1), 0)).to.be.revertedWith(
                "Min underlying redeemed"
            );
            await primaryMarket.redeem(addr2, inM, outBtc, 0);
        });

        it("Should revert if no share can be created", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            await fund.mock.getTotalShares.returns(parseEther("10000"));
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
            await expect(primaryMarket.redeem(addr2, inM, 0, 0)).to.be.revertedWith(
                "Not enough underlying in fund"
            );
            await btc.mint(fund.address, 1);
            await primaryMarket.redeem(addr2, inM, 0, 0);
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketTransferUnderlying.returns();
            await expect(primaryMarket.redeem(addr2, inM, outBtc, 0))
                .to.emit(primaryMarket, "Redeemed")
                .withArgs(addr2, inM, outBtc, feeBtc);
        });
    });

    describe("split()", function () {
        const inM = parseEther("10");
        const outAB = inM.div(2);

        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.split(addr1, inM, 0)).to.be.revertedWith("Only when active");
        });

        it("Should burn and mint shares and add fee debt", async function () {
            const version = 999;
            await expect(() => primaryMarket.split(addr2, inM, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_M, addr1, inM, version),
                },
                {
                    func: fund.mock.primaryMarketMint.withArgs(TRANCHE_A, addr2, outAB, version),
                },
                {
                    func: fund.mock.primaryMarketMint.withArgs(TRANCHE_B, addr2, outAB, version),
                }
            );
        });

        it("Should return split amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            expect(await primaryMarket.callStatic.split(addr2, 0, 0)).to.equal(0);
            expect(await primaryMarket.callStatic.split(addr2, 1, 0)).to.equal(0);
            expect(await primaryMarket.callStatic.split(addr2, 2, 0)).to.equal(1);
            expect(await primaryMarket.callStatic.split(addr2, inM, 0)).to.equal(outAB);
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await expect(primaryMarket.split(addr2, inM, 0))
                .to.emit(primaryMarket, "Split")
                .withArgs(addr2, inM, outAB, outAB);
        });
    });

    describe("merge()", function () {
        const inAB = parseEther("10");
        const feeM = inAB.mul(2).mul(MERGE_FEE_BPS).div(10000);
        const outM = inAB.mul(2).sub(feeM);
        const feeBtc = feeM.mul(TOTAL_UNDERLYING).div(TOTAL_SHARES);

        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.merge(addr1, inAB, 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should burn and mint shares and add fee debt", async function () {
            const version = 999;
            await expect(() => primaryMarket.merge(addr2, inAB, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_A, addr1, inAB, version),
                },
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_B, addr1, inAB, version),
                },
                {
                    func: fund.mock.primaryMarketMint.withArgs(TRANCHE_M, addr2, outM, version),
                },
                {
                    func: fund.mock.primaryMarketAddDebt.withArgs(0, feeBtc),
                }
            );
        });

        it("Should return merged amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            expect(await primaryMarket.callStatic.merge(addr2, 0, 0)).to.equal(0);
            expect(await primaryMarket.callStatic.merge(addr2, 1, 0)).to.equal(2);
            expect(await primaryMarket.callStatic.merge(addr2, inAB, 0)).to.equal(outM);
        });

        it("Should emit an event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketMint.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            await expect(primaryMarket.merge(addr2, inAB, 0))
                .to.emit(primaryMarket, "Merged")
                .withArgs(addr2, outM, inAB, inAB);
        });
    });

    describe("queueRedemption()", function () {
        const inM = parseEther("1");
        const feeBtc = inM
            .mul(TOTAL_UNDERLYING)
            .div(TOTAL_SHARES)
            .mul(REDEMPTION_FEE_BPS)
            .div(10000);
        const outBtc = inM.mul(TOTAL_UNDERLYING).div(TOTAL_SHARES).sub(feeBtc);

        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.queueRedemption(addr1, inM, 0, 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should burn shares and add debt", async function () {
            const version = 999;
            await expect(() => primaryMarket.queueRedemption(addr2, inM, 0, version)).to.callMocks(
                {
                    func: fund.mock.primaryMarketBurn.withArgs(TRANCHE_M, addr1, inM, version),
                },
                {
                    func: fund.mock.primaryMarketAddDebt.withArgs(outBtc, feeBtc),
                }
            );
        });

        it("Should return redeemed underlying amount", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            const ret = await primaryMarket.callStatic.queueRedemption(addr2, inM, 0, 0);
            expect(ret.underlying).to.equal(outBtc);
        });

        it("Should check min underlying redeemed", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            await expect(
                primaryMarket.queueRedemption(addr2, inM, outBtc.add(1), 0)
            ).to.be.revertedWith("Min underlying redeemed");
            await primaryMarket.queueRedemption(addr2, inM, outBtc, 0);
        });

        it("Should revert if no share can be created", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            await fund.mock.getTotalShares.returns(parseEther("10000"));
            await fund.mock.getTotalUnderlying.returns(1);
            await expect(primaryMarket.queueRedemption(addr2, 1, 0, 0)).to.be.revertedWith(
                "Min underlying redeemed"
            );
        });

        it("Should return index in the queue", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            const ret0 = await primaryMarket.callStatic.queueRedemption(addr2, inM, 0, 0);
            expect(ret0.index).to.equal(0);
            await primaryMarket.queueRedemption(addr2, inM, 0, 0);
            await primaryMarket.queueRedemption(addr2, inM, 0, 0);
            const ret1 = await primaryMarket.callStatic.queueRedemption(addr2, inM, 0, 0);
            expect(ret1.index).to.equal(2);
        });

        it("Should append redemption to the queue", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();

            await primaryMarket.queueRedemption(addr2, inM, 0, 0);
            expect(await primaryMarket.redemptionQueueTail()).to.equal(1);
            const redemption0 = await primaryMarket.queuedRedemptions(0);
            expect(redemption0.account).to.equal(addr2);
            expect(redemption0.underlying).to.equal(outBtc);
            expect(redemption0.previousPrefixSum).to.equal(0);
            expect((await primaryMarket.queuedRedemptions(1)).previousPrefixSum).to.equal(outBtc);

            await primaryMarket.queueRedemption(addr1, inM.mul(2), 0, 0);
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
            await fund.mock.primaryMarketAddDebt.returns();
            await expect(primaryMarket.queueRedemption(addr2, inM, outBtc, 0))
                .to.emit(primaryMarket, "Redeemed")
                .withArgs(addr2, inM, outBtc, feeBtc);
        });

        it("Should emit RedemptionQueued event", async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            await primaryMarket.queueRedemption(addr2, inM.mul(2), 0, 0);
            await expect(primaryMarket.queueRedemption(addr2, inM, 0, 0))
                .to.emit(primaryMarket, "RedemptionQueued")
                .withArgs(addr2, 1, outBtc);
        });
    });

    describe("Pop from the redemption queue", function () {
        const outBtcList: BigNumber[] = [];
        const outPrefixSum: BigNumber[] = [];

        beforeEach(async function () {
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            await btc.burn(fund.address, TOTAL_UNDERLYING); // Remove all underlying from the fund
            const inputList = [
                { addr: addr2, inM: parseEther("1") },
                { addr: addr1, inM: parseEther("3") },
                { addr: addr2, inM: parseEther("12") },
                { addr: addr2, inM: parseEther("7") },
            ];
            let sum = BigNumber.from(0);
            for (const { addr, inM } of inputList) {
                await primaryMarket.queueRedemption(addr, inM, 0, 0);
                const feeBtc = inM
                    .mul(TOTAL_UNDERLYING)
                    .div(TOTAL_SHARES)
                    .mul(REDEMPTION_FEE_BPS)
                    .div(10000);
                const outBtc = inM.mul(TOTAL_UNDERLYING).div(TOTAL_SHARES).sub(feeBtc);
                outBtcList.push(outBtc);
                sum = sum.add(outBtc);
                outPrefixSum.push(sum);
            }
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

            it("Should clear the queue if count is zero", async function () {
                await fund.mock.primaryMarketPayDebt.returns();
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await primaryMarket.popRedemptionQueue(0);
                expect(await primaryMarket.redemptionQueueHead()).to.equal(4);
                expect(await primaryMarket.redemptionQueueTail()).to.equal(4);
                await primaryMarket.popRedemptionQueue(0);
                expect(await primaryMarket.redemptionQueueHead()).to.equal(4);
                expect(await primaryMarket.redemptionQueueTail()).to.equal(4);
            });

            it("Should emit an event", async function () {
                await fund.mock.primaryMarketPayDebt.returns();
                await btc.mint(fund.address, TOTAL_UNDERLYING);
                await expect(primaryMarket.popRedemptionQueue(2))
                    .to.emit(primaryMarket, "RedemptionPopped")
                    .withArgs(2, 2);
                await expect(primaryMarket.popRedemptionQueue(2))
                    .to.emit(primaryMarket, "RedemptionPopped")
                    .withArgs(2, 4);
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
            });
        });
    });

    describe("Redemption queue prefix sum", function () {
        it("Should overflow in additions and substractions", async function () {
            await primaryMarket.connect(owner).updateRedemptionFeeRate(0);

            const BIG_UNIT = BigNumber.from(1).shl(252); // 1/16 of 2^256
            await fund.mock.getTotalUnderlying.returns(BIG_UNIT.mul(3));
            await fund.mock.getTotalShares.returns(3);
            // Clear btc minted before and then mint 15 BIG_UNIT. The mock contract never transfers
            // those btc away, so there will be always enough underlying tokens in fund no matter
            // how many redemptions have been done.
            await btc.burn(fund.address, TOTAL_UNDERLYING); // clear btc minted before
            await btc.mint(fund.address, BIG_UNIT.mul(15));

            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
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
            await expect(() => primaryMarket.popRedemptionQueue(5)).to.callMocks({
                func: fund.mock.primaryMarketPayDebt.withArgs(BIG_UNIT.mul(14)),
            });
            await expect(() => primaryMarket.popRedemptionQueue(4)).to.callMocks({
                func: fund.mock.primaryMarketPayDebt.withArgs(BIG_UNIT.mul(12)), // overflow 10 - 14
            });
            await expect(() => primaryMarket.popRedemptionQueue(2)).to.callMocks({
                func: fund.mock.primaryMarketPayDebt.withArgs(BIG_UNIT.mul(6)), // overflow 0 - 10
            });
        });
    });

    describe("Reverse getters", function () {
        it("getCreationForShares()", async function () {
            await fund.mock.getTotalUnderlying.returns(7);
            await fund.mock.getTotalShares.returns(10);
            expect(await primaryMarket.getCreationForShares(0)).to.equal(0);
            expect(await primaryMarket.getCreationForShares(1)).to.equal(1);

            // More shares can be created
            expect(await primaryMarket.getCreationForShares(6)).to.equal(5);
            expect(await primaryMarket.getCreation(5)).to.equal(7);
        });

        it("getRedemptionForUnderlying()", async function () {
            await fund.mock.getTotalUnderlying.returns(10000);
            await fund.mock.getTotalShares.returns(13000);
            await primaryMarket.connect(owner).updateRedemptionFeeRate(parseEther("0.003"));
            expect(await primaryMarket.getRedemptionForUnderlying(0)).to.equal(0);
            expect(await primaryMarket.getRedemptionForUnderlying(997)).to.equal(1300);

            // Less Token M can be redeemed, i.e. suboptimal solution
            expect(await primaryMarket.getRedemptionForUnderlying(665)).to.equal(868);
            expect((await primaryMarket.getRedemption(866)).underlying).to.equal(665);
        });

        it("getSplitForAB()", async function () {
            expect(await primaryMarket.getSplitForAB(0)).to.equal(0);
            expect(await primaryMarket.getSplitForAB(1)).to.equal(2);
            expect(await primaryMarket.getSplitForAB(parseEther("1"))).to.equal(parseEther("2"));
        });

        it("getMergeForM()", async function () {
            await primaryMarket.connect(owner).updateMergeFeeRate(parseEther("0.003"));
            expect(await primaryMarket.getMergeForM(0)).to.equal(0);
            expect(await primaryMarket.getMergeForM(9970)).to.equal(5000);

            // More Token M can be received
            expect(await primaryMarket.getMergeForM(1000)).to.equal(502);
            expect((await primaryMarket.getMerge(502)).outM).to.equal(1001);

            // Less Token A/B can be spent, i.e. suboptimal solution
            expect(await primaryMarket.getMergeForM(665)).to.equal(334);
            expect((await primaryMarket.getMerge(333)).outM).to.equal(665);
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
            await fund.mock.getTotalShares.returns(TOTAL_SHARES);
            const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
            primaryMarket = await PrimaryMarket.connect(owner).deploy(
                fund.address,
                parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
                parseEther("0.0001").mul(MERGE_FEE_BPS),
                BigNumber.from(1).shl(256).sub(1)
            );
            primaryMarket = primaryMarket.connect(user1);
        });

        it("wrapAndCreate()", async function () {
            const inEth = parseEther("1");
            const outM = inEth.mul(TOTAL_SHARES).div(ETH_TOTAL_UNDERLYING);
            const version = 999;
            await fund.mock.primaryMarketMint.withArgs(TRANCHE_M, addr2, outM, version).returns();
            expect(
                await primaryMarket.callStatic.wrapAndCreate(addr2, 0, version, { value: inEth })
            ).to.equal(outM);
            await expect(() =>
                primaryMarket.wrapAndCreate(addr2, 0, version, { value: inEth })
            ).to.changeEtherBalance(user1, inEth.mul(-1));
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(0);
            expect(await weth.balanceOf(fund.address)).to.equal(inEth);
        });

        it("redeemAndUnwrap()", async function () {
            const inM = parseEther("1");
            const feeEth = inM
                .mul(ETH_TOTAL_UNDERLYING)
                .div(TOTAL_SHARES)
                .mul(REDEMPTION_FEE_BPS)
                .div(10000);
            const outEth = inM.mul(ETH_TOTAL_UNDERLYING).div(TOTAL_SHARES).sub(feeEth);
            const version = 999;
            await weth.connect(owner).deposit({ value: outEth.mul(2) });
            await weth.connect(owner).transfer(primaryMarket.address, outEth);
            await weth.connect(owner).transfer(fund.address, outEth);
            await fund.mock.primaryMarketBurn.withArgs(TRANCHE_M, addr1, inM, version).returns();
            await fund.mock.primaryMarketTransferUnderlying
                .withArgs(primaryMarket.address, outEth, feeEth)
                .returns();
            expect(await primaryMarket.callStatic.redeemAndUnwrap(addr2, inM, 0, version)).to.equal(
                outEth
            );
            await expect(() =>
                primaryMarket.redeemAndUnwrap(addr2, inM, 0, version)
            ).to.changeEtherBalance(user2, outEth);
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(0);
        });

        it("claimRedemptionsAndUnwrap()", async function () {
            const inM = parseEther("1");
            const feeEth = inM
                .mul(ETH_TOTAL_UNDERLYING)
                .div(TOTAL_SHARES)
                .mul(REDEMPTION_FEE_BPS)
                .div(10000);
            const outEth = inM.mul(ETH_TOTAL_UNDERLYING).div(TOTAL_SHARES).sub(feeEth);
            await weth.connect(owner).deposit({ value: outEth.mul(2) });
            await weth.connect(owner).transfer(primaryMarket.address, outEth);
            await weth.connect(owner).transfer(fund.address, outEth);
            await fund.mock.primaryMarketBurn.returns();
            await fund.mock.primaryMarketAddDebt.returns();
            await primaryMarket.queueRedemption(addr2, inM, 0, 0);

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
});
