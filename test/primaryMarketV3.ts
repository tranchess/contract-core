import { AssertionError, expect } from "chai";
import { BigNumber, Contract, Transaction, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import { TRANCHE_M, TRANCHE_A, TRANCHE_B, DAY, FixtureWalletMap } from "./utils";

const REDEMPTION_FEE_BPS = 35;
const SPLIT_FEE_BPS = 40;
const MERGE_FEE_BPS = 45;
const MIN_CREATION_AMOUNT = 5;

const START_DAY = 1609556400; // 2021-01-02 03:00:00

async function parseEvent(tx: Transaction, contract: Contract, eventName: string) {
    const receipt = await contract.provider.waitForTransaction(tx.hash as string);
    const topic = contract.interface.getEventTopic(eventName);
    for (const log of receipt.logs) {
        if (
            log.topics.includes(topic) &&
            log.address.toLowerCase() == contract.address.toLowerCase()
        ) {
            return contract.interface.parseLog(log).args;
        }
    }
    throw new AssertionError(`Cannot find event ${eventName}`);
}

describe("PrimaryMarket", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly btc: Contract;
        readonly twapOracle: MockContract;
        readonly fund: Contract;
        readonly shareM: Contract;
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
    let shareM: Contract;
    let primaryMarket: Contract;

    function settleWithShare(
        day: number,
        shares: number | BigNumber,
        underlying: number | BigNumber
    ): Promise<Transaction> {
        return fund.call(primaryMarket, "settle", day, shares, underlying, 0, 0);
    }

    function getCreation(
        underlying: BigNumber,
        fundUnderlying: number | BigNumber = parseBtc("1"),
        fundTotalShares: number | BigNumber = parseEther("1")
    ): BigNumber {
        return underlying.mul(fundTotalShares).div(fundUnderlying);
    }

    function getRedemption(
        shares: BigNumber,
        fundUnderlying: number | BigNumber = parseBtc("1"),
        fundTotalShares: number | BigNumber = parseEther("1")
    ): [BigNumber, BigNumber] {
        const underlying = shares.mul(fundUnderlying).div(fundTotalShares);
        const redemptionFee = underlying.mul(REDEMPTION_FEE_BPS).div(10000);
        const redeemedUnderlying = underlying.sub(redemptionFee);
        return [redeemedUnderlying, redemptionFee];
    }
    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        const fund = await deployMockForName(owner, "FundV3");
        const shareM = await deployMockForName(owner, "Share");
        const shareA = await deployMockForName(owner, "Share");
        const shareB = await deployMockForName(owner, "Share");
        await fund.mock.trancheWeights.returns(1, 1);
        await fund.mock.tokenUnderlying.returns(btc.address);
        await fund.mock.tokenM.returns(shareM.address);
        await fund.mock.tokenA.returns(shareA.address);
        await fund.mock.tokenB.returns(shareB.address);
        await fund.mock.underlyingDecimalMultiplier.returns(1e10);
        await fund.mock.currentDay.returns(START_DAY);
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.isPrimaryMarketActive.returns(true);
        await fund.mock.getTotalShares.returns(parseEther("1"));
        await fund.mock.getTotalUnderlying.returns(parseBtc("1"));
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseUnits(REDEMPTION_FEE_BPS.toString(), 18 - 4),
            parseUnits(SPLIT_FEE_BPS.toString(), 18 - 4),
            parseUnits(MERGE_FEE_BPS.toString(), 18 - 4),
            MIN_CREATION_AMOUNT,
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
            shareM,
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
        shareM = fixtureData.shareM;
        primaryMarket = fixtureData.primaryMarket;
    });

    describe("create()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.create(addr1, parseBtc("1"), 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should check minimum creation amount", async function () {
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(BigNumber.from(MIN_CREATION_AMOUNT)), 0)
                .returns();
            await expect(
                primaryMarket.create(addr1, MIN_CREATION_AMOUNT - 1, 0)
            ).to.be.revertedWith("Min amount");
            await primaryMarket.create(addr1, MIN_CREATION_AMOUNT, 0);
        });

        it("Should create using price and NAV when fund was empty", async function () {
            // Create with 1 BTC at price 30000 and NAV 0.5
            const inBtc = parseBtc("1");
            const outM = parseEther("60000");
            await fund.mock.getTotalShares.returns(0);
            await fund.mock.getTotalUnderlying.returns(0);
            await fund.mock.twapOracle.returns(twapOracle.address);
            await twapOracle.mock.getTwap.returns(parseEther("30000"));
            await fund.mock.historicalNavs.returns(parseEther("0.5"), 0, 0);
            await fund.mock.mint.withArgs(TRANCHE_M, addr1, outM, 0).returns();
            await expect(primaryMarket.create(addr1, inBtc, 0))
                .to.emit(primaryMarket, "Created")
                .withArgs(addr1, inBtc, outM);
        });

        it("Should transfer underlying and save the creation", async function () {
            const amount = parseBtc("1");
            await fund.mock.mint.withArgs(TRANCHE_M, addr1, getCreation(amount), 0).returns();
            const tx = () => primaryMarket.create(addr1, amount, 0);
            await expect(tx).to.changeTokenBalance(btc, fund, amount);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(addr1);
            expect(cr.creatingUnderlying).to.equal(0);
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(0);
        });

        it("Should handle multiple creations in the same day", async function () {
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("2")), 0)
                .returns();
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("3")), 0)
                .returns();
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr2, getCreation(parseBtc("4")), 0)
                .returns();
            await primaryMarket.create(addr1, parseBtc("2"), 0);
            await primaryMarket.create(addr1, parseBtc("3"), 0);
            await primaryMarket.connect(user2).create(addr2, parseBtc("4"), 0);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(addr1);
            expect(cr.creatingUnderlying).to.equal(0);
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(0);
        });

        it("Should not be claimable in the same day", async function () {
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("1")), 0)
                .returns();
            await primaryMarket.create(addr1, parseBtc("1"), 0);
            // No shares or underlying is transfered
            const tx = () => primaryMarket.claim(addr1);
            await expect(tx).to.changeTokenBalances(btc, [user1, fund], [0, 0]);
        });

        it("Should emit an event", async function () {
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("1")), 0)
                .returns();
            await expect(primaryMarket.create(addr1, parseBtc("1"), 0))
                .to.emit(primaryMarket, "Created")
                .withArgs(addr1, parseBtc("1"), parseEther("1"));
        });
    });

    describe("redeem()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.redeem(addr1, parseEther("1"), 0)).to.be.revertedWith(
                "Only when active"
            );
            await expect(primaryMarket.delayRedeem(addr1, parseEther("1"), 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should revert on zero shares", async function () {
            await expect(primaryMarket.redeem(addr1, 0, 0)).to.be.revertedWith("Zero shares");
            await expect(primaryMarket.delayRedeem(addr1, 0, 0)).to.be.revertedWith("Zero shares");
        });

        it("Should revert on not enough available hot balance", async function () {
            const amount = parseEther("1");
            await fund.mock.burn.withArgs(TRANCHE_M, addr1, amount, 0).returns();
            await expect(primaryMarket.redeem(addr1, amount, 0)).to.be.revertedWith(
                "Not enough available hot balance"
            );
        });

        it("Should instantly redeem if enough hot balance", async function () {
            await btc.mint(fund.address, parseBtc("10"));
            const amount = parseEther("1");
            await fund.mock.burn.withArgs(TRANCHE_M, addr1, amount, 0).returns();
            const [underlying, fee] = getRedemption(amount);
            await fund.mock.transferToPrimaryMarket.withArgs(addr1, underlying, fee).returns();
            await primaryMarket.redeem(addr1, amount, 0);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(addr1);
            expect(cr.redeemingShares).to.equal(0);
            expect(await primaryMarket.currentRedeemingShares()).to.equal(0);
        });

        it("Should transfer shares and save the redemption if not enough hot balance", async function () {
            const amount = parseEther("1");
            await fund.mock.burn.withArgs(TRANCHE_M, addr1, amount, 0).returns();
            await fund.mock.mint.withArgs(TRANCHE_M, primaryMarket.address, amount, 0).returns();
            await primaryMarket.delayRedeem(addr1, amount, 0);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(addr1);
            expect(cr.redeemingShares).to.equal(amount);
            expect(await primaryMarket.currentRedeemingShares()).to.equal(amount);
        });

        it("Should combine multiple redemptions in the same day", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.delayRedeem(addr1, parseEther("2"), 0);
            await primaryMarket.delayRedeem(addr1, parseEther("3"), 0);
            await primaryMarket.connect(user2).delayRedeem(addr2, parseEther("4"), 0);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(addr1);
            expect(cr.redeemingShares).to.equal(parseEther("5"));
            expect(await primaryMarket.currentRedeemingShares()).to.equal(parseEther("9"));
        });

        it("Should not be claimable in the same day", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.delayRedeem(addr1, parseEther("1"), 0);
            await fund.mock.burn.revertsWithReason("Mock function reset");
            await fund.mock.mint.revertsWithReason("Mock function reset");
            // No shares or underlying is transfered
            const tx = () => primaryMarket.claim(addr1);
            await expect(tx).to.changeTokenBalances(btc, [user1, fund], [0, 0]);
        });

        it("Should emit an event", async function () {
            await btc.mint(fund.address, parseBtc("10"));
            const amount = parseEther("1");
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            const [underlying, fee] = getRedemption(amount);
            await fund.mock.transferToPrimaryMarket.withArgs(addr1, underlying, fee).returns();
            await expect(primaryMarket.redeem(addr1, parseEther("1"), 0))
                .to.emit(primaryMarket, "Redeemed")
                .withArgs(addr1, parseEther("1"), underlying, fee);
        });
    });

    describe("split()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.split(addr1, parseEther("1"), 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should revert if too little to split", async function () {
            await expect(primaryMarket.split(addr1, 1, 0)).to.be.revertedWith(
                "Too little to split"
            );
        });

        it("Should burn and mint shares", async function () {
            // No rounding in this case
            const inM = 10000 * 20;
            const feeM = SPLIT_FEE_BPS * 20;
            const outA = (10000 - SPLIT_FEE_BPS) * 10;
            const outB = (10000 - SPLIT_FEE_BPS) * 10;
            await expect(() => primaryMarket.split(addr1, inM, 0)).to.callMocks(
                {
                    func: fund.mock.burn.withArgs(TRANCHE_M, addr1, inM, 0),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_A, addr1, outA, 0),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_B, addr1, outB, 0),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_M, primaryMarket.address, feeM, 0),
                }
            );
        });

        it("Should update fee in shares", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.split(addr1, 10000 * 10, 0);
            expect(await primaryMarket.currentFeeInShares()).to.equal(SPLIT_FEE_BPS * 10);
        });

        it("Should add unsplittable M shares to fee", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            // The last 1 Token M cannot be split and goes to fee
            const inM = 10000 * 20 + 1;
            const feeM = SPLIT_FEE_BPS * 20 + 1;
            await primaryMarket.split(addr1, inM, 0);
            expect(await primaryMarket.currentFeeInShares()).to.equal(feeM);
        });

        it("Should emit an event", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await expect(primaryMarket.split(addr1, 20000, 0))
                .to.emit(primaryMarket, "Split")
                .withArgs(addr1, 20000, 10000 - SPLIT_FEE_BPS, 10000 - SPLIT_FEE_BPS);
        });
    });

    describe("merge()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.merge(addr1, parseEther("1"), 0)).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should revert if too little to merge", async function () {
            await fund.mock.trancheWeights.returns(100, 1);
            await expect(primaryMarket.merge(addr1, 99, 0)).to.be.revertedWith(
                "Too little to merge"
            );
        });

        it("Should burn and mint shares", async function () {
            // No rounding in this case
            const inA = 10000 * 10;
            const inB = 10000 * 10;
            const feeM = MERGE_FEE_BPS * 20;
            const outM = (10000 - MERGE_FEE_BPS) * 20;
            await expect(() => primaryMarket.merge(addr1, inA, 0)).to.callMocks(
                {
                    func: fund.mock.burn.withArgs(TRANCHE_A, addr1, inA, 0),
                },
                {
                    func: fund.mock.burn.withArgs(TRANCHE_B, addr1, inB, 0),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_M, addr1, outM, 0),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_M, primaryMarket.address, feeM, 0),
                }
            );
        });

        it("Should update fee in shares", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.merge(addr1, 50000, 0);
            expect(await primaryMarket.currentFeeInShares()).to.equal(MERGE_FEE_BPS * 10);
        });

        it("Should keeps unmergable Token A unchanged", async function () {
            await fund.mock.trancheWeights.returns(100, 200);
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await expect(() => primaryMarket.merge(addr1, 199, 0)).to.callMocks({
                func: fund.mock.burn.withArgs(TRANCHE_A, addr1, 100, 0),
            });
        });

        it("Should emit an event", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await expect(primaryMarket.merge(addr1, 10000, 0))
                .to.emit(primaryMarket, "Merged")
                .withArgs(addr1, (10000 - MERGE_FEE_BPS) * 2, 10000, 10000);
        });
    });

    describe("settle()", function () {
        it("Should revert if not called from Fund", async function () {
            await expect(primaryMarket.settle(START_DAY, 0, 0, 1, 1)).to.be.revertedWith(
                "Only fund"
            );
        });

        it("Should revert if already settled", async function () {
            await expect(
                fund.call(primaryMarket, "settle", START_DAY - DAY, 0, 0, 1, 1)
            ).to.be.revertedWith("Already settled");
        });

        it("Should succeed when nothing happened and fund was empty", async function () {
            await fund.call(primaryMarket, "settle", START_DAY, 0, 0, 1, 1);
            expect(await primaryMarket.currentDay()).to.equal(START_DAY + DAY);
        });

        it("Should settle redemption using last shares and underlying", async function () {
            // Fund had 10 BTC and 10000 shares
            // Redeem 1000 shares for 1 BTC
            const fee = parseBtc("1").mul(REDEMPTION_FEE_BPS).div(10000);
            const redeemed = parseBtc("1").sub(fee);
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.delayRedeem(addr1, parseEther("1000"), 0);
            await fund.mock.burn.revertsWithReason("Mock function reset");
            await fund.mock.mint.revertsWithReason("Mock function reset");
            await expect(settleWithShare(START_DAY, parseEther("10000"), parseBtc("10")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, parseEther("1000"), 0, redeemed, fee);
            // No BTC to be transfered
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(0);
        });

        it("Should round down redemption shares and fee", async function () {
            // Fund had 2500 underlying units and 900 share units
            // Redeem 600 share units
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.delayRedeem(addr1, 600, 0);
            // Redeemed before fee: 600 * 2500 / 900 = 1666
            // Fee: 1666 * 0.0035 = 5
            // Redeemed after fee: 1666 - 5 = 1661
            await expect(settleWithShare(START_DAY, 900, 2500))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, 600, 0, 1661, 5);
        });

        it("Should net underlying (creation < redemption)", async function () {
            // Fund had 10 BTC and 10000 shares
            // Create with 1 BTC and redeem all the 10000 shares
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("1")), 0)
                .returns();
            await primaryMarket.create(addr1, parseBtc("1"), 0);
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.delayRedeem(addr1, parseEther("10000"), 0);
            const redemptionUnderlying = parseBtc("10")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            const tx = await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.creationUnderlying).to.equal(0);
            expect(event.redemptionUnderlying).to.equal(redemptionUnderlying);
            // No BTC to be transfered
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(0);
        });

        it("Should settle split and merge fee", async function () {
            // Fund had 10 BTC and 10000 shares
            // Split 1000 M and merge 100 A and 100 B
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.split(addr1, parseEther("1000"), 0);
            await primaryMarket.connect(user2).merge(addr2, parseEther("100"), 0);
            const splitFee = parseEther("1000").mul(SPLIT_FEE_BPS).div(10000);
            const mergeFee = parseEther("200").mul(MERGE_FEE_BPS).div(10000);
            const feeInShares = splitFee.add(mergeFee);
            const feeInBtc = feeInShares.mul(parseBtc("10")).div(parseEther("10000"));
            await expect(settleWithShare(START_DAY, parseEther("10000"), parseBtc("10")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, feeInShares, 0, 0, feeInBtc);
            // No BTC to be transfered
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(0);
        });

        it("Should settle everything together", async function () {
            // Fund had 10 BTC and 10000 shares
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("1")), 0)
                .returns();
            // Create with 1 BTC
            await primaryMarket.connect(user2).create(addr1, parseBtc("1"), 0);
            // Redeem 1000 shares
            await primaryMarket.delayRedeem(addr1, parseEther("1000"), 0);
            const redemptionFee = parseBtc("1").mul(REDEMPTION_FEE_BPS).div(10000);
            const redeemedBtc = parseBtc("1").sub(redemptionFee);
            // Split 1000 M and merge 100 A and 100 B
            await primaryMarket.split(addr1, parseEther("1000"), 0);
            await primaryMarket.connect(user2).merge(addr2, parseEther("100"), 0);
            const splitFee = parseEther("1000").mul(SPLIT_FEE_BPS).div(10000);
            const mergeFee = parseEther("200").mul(MERGE_FEE_BPS).div(10000);
            const feeInShares = splitFee.add(mergeFee);
            const feeInBtc = feeInShares.mul(parseBtc("10")).div(parseEther("10000"));
            const tx = await settleWithShare(START_DAY + DAY, parseEther("10000"), parseBtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.sharesToMint).to.equal(0);
            expect(event.sharesToBurn).to.equal(parseEther("1000").add(feeInShares));
            expect(event.creationUnderlying).to.equal(0);
            expect(event.redemptionUnderlying).to.equal(redeemedBtc);
            expect(event.fee).to.equal(redemptionFee.add(feeInBtc));
        });
    });

    describe("claim()", function () {
        let outerFixture: Fixture<FixtureData>;
        let redeemedBtc: BigNumber;

        interface SettleFixtureData extends FixtureData {
            redeemedBtc: BigNumber;
        }

        async function settleFixture(): Promise<SettleFixtureData> {
            const f = await loadFixture(deployFixture);
            await f.fund.mock.getRebalanceSize.returns(0);
            await f.fund.mock.burn.returns();
            await f.fund.mock.mint.returns();
            await f.primaryMarket.create(addr1, parseBtc("1"), 0);
            await f.primaryMarket.delayRedeem(addr1, parseEther("1000"), 0);
            await f.fund.call(
                f.primaryMarket,
                "settle",
                START_DAY,
                parseEther("10000"),
                parseBtc("10"),
                0,
                0
            );
            await f.fund.call(
                f.btc,
                "transfer",
                f.primaryMarket.address,
                parseBtc("1")
                    .mul(10000 - REDEMPTION_FEE_BPS)
                    .div(10000)
            );
            const redeemedBtc = parseBtc("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            return { redeemedBtc, ...f };
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = settleFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        beforeEach(function () {
            const f = fixtureData as SettleFixtureData;
            redeemedBtc = f.redeemedBtc;
        });

        it("Should transfer redeemed underlying", async function () {
            await shareM.mock.transfer.returns(true);
            await expect(() => primaryMarket.claim(addr1)).to.changeTokenBalances(
                btc,
                [user1, primaryMarket],
                [redeemedBtc, redeemedBtc.mul(-1)]
            );
        });

        it("Should combine claimable redemptions in different days", async function () {
            await primaryMarket.delayRedeem(addr1, parseEther("2000"), 0);
            // Day (START_DAY + DAY) is not settled
            await settleWithShare(START_DAY + DAY * 2, parseEther("20000"), parseBtc("40"));
            const redeemedAgain = parseBtc("4")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            // Fund should transfer redeemed underlying after settlement
            await btc.mint(primaryMarket.address, redeemedAgain);
            const total = redeemedBtc.add(redeemedAgain);
            await shareM.mock.transfer.returns(true);
            await expect(() => primaryMarket.claim(addr1)).to.changeTokenBalances(
                btc,
                [user1, primaryMarket],
                [total, total.mul(-1)]
            );
        });
    });

    describe("Delayed redemption", function () {
        const redeemedPerShare = parseBtc("0.001")
            .mul(10000 - REDEMPTION_FEE_BPS)
            .div(10000);
        const btcU1D0 = redeemedPerShare.mul(1000);
        const btcU1D1 = redeemedPerShare.mul(500);
        const btcU2D1 = redeemedPerShare.mul(2000);
        const btcU1D3 = redeemedPerShare.mul(1500);
        const btcU2D3 = redeemedPerShare.mul(3000);
        const btcU1D4 = redeemedPerShare.mul(200);
        const btcU2D4 = redeemedPerShare.mul(300);

        beforeEach(async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.connect(user1).delayRedeem(addr1, parseEther("1000"), 0);
            await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            await primaryMarket.connect(user1).delayRedeem(addr1, parseEther("500"), 0);
            await primaryMarket.connect(user2).delayRedeem(addr2, parseEther("2000"), 0);
            await settleWithShare(START_DAY + DAY, parseEther("9000"), parseBtc("9"));
            await settleWithShare(START_DAY + DAY * 2, parseEther("6500"), parseBtc("6.5"));
            await primaryMarket.connect(user1).delayRedeem(addr1, parseEther("1500"), 0);
            await primaryMarket.connect(user2).delayRedeem(addr2, parseEther("3000"), 0);
            await settleWithShare(START_DAY + DAY * 3, parseEther("6500"), parseBtc("6.5"));
            await primaryMarket.connect(user1).delayRedeem(addr1, parseEther("200"), 0);
            await primaryMarket.connect(user2).delayRedeem(addr2, parseEther("300"), 0);
            await settleWithShare(START_DAY + DAY * 4, parseEther("2000"), parseBtc("2"));
        });

        it("getDelayedRedemption()", async function () {
            const getter = async (user: Wallet, day: number): Promise<[BigNumber, number]> => {
                const ret = await primaryMarket.getDelayedRedemption(user.address, day);
                return [ret.underlying, ret.nextDay.toNumber()];
            };
            expect(await getter(user1, START_DAY)).to.eql([btcU1D0, START_DAY + DAY]);
            expect(await getter(user2, START_DAY)).to.eql([BigNumber.from(0), 0]);
            expect(await getter(user1, START_DAY + DAY)).to.eql([btcU1D1, START_DAY + DAY * 3]);
            expect(await getter(user2, START_DAY + DAY)).to.eql([btcU2D1, START_DAY + DAY * 3]);
            expect(await getter(user1, START_DAY + DAY * 2)).to.eql([BigNumber.from(0), 0]);
            expect(await getter(user2, START_DAY + DAY * 2)).to.eql([BigNumber.from(0), 0]);
            expect(await getter(user1, START_DAY + DAY * 3)).to.eql([btcU1D3, 0]);
            expect(await getter(user2, START_DAY + DAY * 3)).to.eql([btcU2D3, 0]);

            // Redemption results are calculated only after user calls the contract
            expect(await getter(user1, START_DAY + DAY * 4)).to.eql([BigNumber.from(0), 0]);
            expect(await getter(user2, START_DAY + DAY * 4)).to.eql([BigNumber.from(0), 0]);
            await primaryMarket.claim(addr1);
            await primaryMarket.connect(user2).delayRedeem(addr2, parseEther("1"), 0);
            expect(await getter(user1, START_DAY + DAY * 3)).to.eql([btcU1D3, START_DAY + DAY * 4]);
            expect(await getter(user2, START_DAY + DAY * 3)).to.eql([btcU2D3, START_DAY + DAY * 4]);
            expect(await getter(user1, START_DAY + DAY * 4)).to.eql([btcU1D4, 0]);
            expect(await getter(user2, START_DAY + DAY * 4)).to.eql([btcU2D4, 0]);
        });

        it("getDelayedRedemptionHead()", async function () {
            expect(await primaryMarket.getDelayedRedemptionHead(addr1)).to.equal(START_DAY);
            expect(await primaryMarket.getDelayedRedemptionHead(addr2)).to.equal(START_DAY + DAY);
        });

        it("updateDelayedRedemptionDay()", async function () {
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY);
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY);

            await fund.mock.mint.withArgs(TRANCHE_M, addr2, getCreation(btcU1D0), 0).returns();
            await primaryMarket.connect(user2).create(addr2, btcU1D0, 0);
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY);

            await btc.mint(primaryMarket.address, btcU1D1.add(btcU2D1).sub(parseBtc("0.0001")));
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY);

            await btc.mint(primaryMarket.address, parseBtc("0.0001"));
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY);
        });

        it("Should be claimable after the contract has enough tokens", async function () {
            await btc.mint(
                primaryMarket.address,
                btcU1D0.add(btcU1D1).add(btcU2D1).sub(parseBtc("0.001"))
            );
            await expect(() => primaryMarket.claim(addr1)).to.changeTokenBalance(
                btc,
                user1,
                btcU1D0
            );
            await expect(() => primaryMarket.claim(addr2)).to.changeTokenBalance(btc, user2, 0);
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY);
            expect(await primaryMarket.getDelayedRedemptionHead(addr1)).to.equal(START_DAY + DAY);
            expect(await primaryMarket.getDelayedRedemptionHead(addr2)).to.equal(START_DAY + DAY);

            await btc.mint(primaryMarket.address, btcU1D3.add(btcU2D3).add(parseBtc("0.005")));
            await expect(() => primaryMarket.claim(addr1)).to.changeTokenBalance(
                btc,
                user1,
                btcU1D1.add(btcU1D3)
            );
            await expect(() => primaryMarket.claim(addr2)).to.changeTokenBalance(
                btc,
                user2,
                btcU2D1.add(btcU2D3)
            );
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY * 4);
            expect(await primaryMarket.getDelayedRedemptionHead(addr1)).to.equal(
                START_DAY + DAY * 4
            );
            expect(await primaryMarket.getDelayedRedemptionHead(addr2)).to.equal(
                START_DAY + DAY * 4
            );

            await btc.mint(primaryMarket.address, btcU1D4.add(btcU2D4));
            await expect(() => primaryMarket.claim(addr1)).to.changeTokenBalance(
                btc,
                user1,
                btcU1D4
            );
            await expect(() => primaryMarket.claim(addr2)).to.changeTokenBalance(
                btc,
                user2,
                btcU2D4
            );
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY * 5);
            expect(await primaryMarket.getDelayedRedemptionHead(addr1)).to.equal(0);
            expect(await primaryMarket.getDelayedRedemptionHead(addr2)).to.equal(0);
        });
    });

    describe("Fund cap", function () {
        beforeEach(async function () {
            const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
            primaryMarket = await PrimaryMarket.connect(owner).deploy(
                fund.address,
                parseUnits(REDEMPTION_FEE_BPS.toString(), 18 - 4),
                parseUnits(SPLIT_FEE_BPS.toString(), 18 - 4),
                parseUnits(MERGE_FEE_BPS.toString(), 18 - 4),
                MIN_CREATION_AMOUNT,
                0
            );
            primaryMarket = primaryMarket.connect(user1);
            await fund.mock.isPrimaryMarketActive.returns(true);

            await btc.connect(user1).approve(primaryMarket.address, parseBtc("10000"));
            await btc.connect(user2).approve(primaryMarket.address, parseBtc("10000"));
        });

        it("Should revert when cap is zero", async function () {
            await fund.mock.historicalUnderlying.withArgs(START_DAY - DAY).returns(0);
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("1")), 0)
                .returns();
            await expect(
                primaryMarket.connect(user1).create(addr1, parseBtc("1"), 0)
            ).to.be.revertedWith("Exceed fund cap");
        });

        it("Should revert when creation amount exceeds total cap", async function () {
            await primaryMarket.connect(owner).updateFundCap(parseBtc("1.8"));

            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseBtc("0.6")), 0)
                .returns();
            await primaryMarket.create(addr1, parseBtc("0.6"), 0);

            await fund.mock.getTotalUnderlying.returns(parseBtc("1.6"));
            await fund.mock.mint
                .withArgs(
                    TRANCHE_M,
                    addr2,
                    getCreation(parseBtc("0.3"), parseBtc("1.6"), parseEther("1")),
                    0
                )
                .returns();
            await expect(
                primaryMarket.connect(user2).create(addr2, parseBtc("0.3"), 0)
            ).to.be.revertedWith("Exceed fund cap");

            await fund.mock.mint
                .withArgs(
                    TRANCHE_M,
                    addr1,
                    getCreation(parseBtc("0.2"), parseBtc("1.6"), parseEther("1")),
                    0
                )
                .returns();
            await primaryMarket.create(addr1, parseBtc("0.2"), 0);
        });
    });

    describe("Wrapped native currency", function () {
        let weth: Contract;

        beforeEach(async function () {
            const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
            weth = await MockWrappedToken.connect(owner).deploy("Wrapped ETH", "ETH");
            weth = weth.connect(user1);
            await fund.mock.tokenUnderlying.returns(weth.address);
            const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
            primaryMarket = await PrimaryMarket.connect(owner).deploy(
                fund.address,
                parseUnits(REDEMPTION_FEE_BPS.toString(), 18 - 4),
                parseUnits(SPLIT_FEE_BPS.toString(), 18 - 4),
                parseUnits(MERGE_FEE_BPS.toString(), 18 - 4),
                MIN_CREATION_AMOUNT,
                BigNumber.from(1).shl(256).sub(1)
            );
            primaryMarket = primaryMarket.connect(user1);
        });

        it("wrapAndCreate()", async function () {
            const amount = parseEther("3");
            await fund.mock.mint.withArgs(TRANCHE_M, addr1, getCreation(amount), 0).returns();
            await expect(() =>
                primaryMarket.wrapAndCreate(addr1, 0, { value: amount })
            ).to.changeEtherBalance(user1, amount.mul(-1));
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(0);
            expect(await weth.balanceOf(fund.address)).to.equal(amount);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(addr1);
            expect(cr.creatingUnderlying).to.equal(0);
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(0);
        });

        it("Mixed creation", async function () {
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseEther("3")), 0)
                .returns();
            await primaryMarket.wrapAndCreate(addr1, 0, { value: parseEther("3") });
            await weth.deposit({ value: parseEther("4") });
            await weth.approve(primaryMarket.address, parseEther("4"));
            await fund.mock.mint
                .withArgs(TRANCHE_M, addr1, getCreation(parseEther("4")), 0)
                .returns();
            await primaryMarket.create(addr1, parseEther("4"), 0);
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(0);
            expect(await weth.balanceOf(fund.address)).to.equal(parseEther("7"));
            const cr = await primaryMarket.callStatic.creationRedemptionOf(addr1);
            expect(cr.creatingUnderlying).to.equal(0);
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(0);
        });

        it("claimAndUnwrap() for redemption", async function () {
            await weth.connect(owner).deposit({ value: parseEther("999") });
            await weth.connect(owner).transfer(primaryMarket.address, parseEther("999"));
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.connect(user1).delayRedeem(addr1, parseEther("1000"), 0);
            await settleWithShare(START_DAY, parseEther("10000"), parseEther("10"));

            const redeemed = parseEther("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            await expect(() => primaryMarket.claimAndUnwrap(addr1)).to.changeEtherBalance(
                user1,
                redeemed
            );
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(
                parseEther("999").sub(redeemed)
            );
        });
    });
});
