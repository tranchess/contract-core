import { AssertionError, expect } from "chai";
import { BigNumber, Contract, Transaction, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseWbtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";

const TRANCHE_P = 0;
const TRANCHE_A = 1;
const TRANCHE_B = 2;
const CREATION_FEE_BPS = 3000;
const REDEMPTION_FEE_BPS = 3500;
const SPLIT_FEE_BPS = 4000;
const MERGE_FEE_BPS = 4500;
const MIN_CREATION_AMOUNT = 5;

const DAY = 86400; // 1 day
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
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly wbtc: Contract;
        readonly fund: Contract;
        readonly shareP: Contract;
        readonly primaryMarket: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let wbtc: Contract;
    let fund: Contract;
    let shareP: Contract;
    let primaryMarket: Contract;

    function settleWithNav(
        day: number,
        price: number | BigNumber,
        nav: number | BigNumber
    ): Promise<Transaction> {
        return fund.call(primaryMarket, "settle", day, 0, 0, price, nav);
    }

    function settleWithShare(
        day: number,
        shares: number | BigNumber,
        underlying: number | BigNumber
    ): Promise<Transaction> {
        return fund.call(primaryMarket, "settle", day, shares, underlying, 0, 0);
    }

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        const MockToken = await ethers.getContractFactory("MockToken");
        const wbtc = await MockToken.connect(owner).deploy("Wrapped BTC", "WBTC", 8);
        const fund = await deployMockForName(owner, "Fund");
        const shareP = await deployMockForName(owner, "Share");
        const shareA = await deployMockForName(owner, "Share");
        const shareB = await deployMockForName(owner, "Share");
        await fund.mock.splitWeights.returns(1, 1);
        await fund.mock.tokenUnderlying.returns(wbtc.address);
        await fund.mock.tokenP.returns(shareP.address);
        await fund.mock.tokenA.returns(shareA.address);
        await fund.mock.tokenB.returns(shareB.address);
        await fund.mock.underlyingDecimalMultiplier.returns(1e10);
        await fund.mock.currentDay.returns(START_DAY);
        await fund.mock.isPrimaryMarketActive.returns(true);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarket");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseUnits(CREATION_FEE_BPS.toString(), 18 - 4),
            parseUnits(REDEMPTION_FEE_BPS.toString(), 18 - 4),
            parseUnits(SPLIT_FEE_BPS.toString(), 18 - 4),
            parseUnits(MERGE_FEE_BPS.toString(), 18 - 4),
            MIN_CREATION_AMOUNT
        );

        // Set initial state
        await wbtc.mint(user1.address, parseWbtc("10000"));
        await wbtc.mint(user2.address, parseWbtc("10000"));
        await wbtc.connect(user1).approve(primaryMarket.address, parseWbtc("10000"));
        await wbtc.connect(user2).approve(primaryMarket.address, parseWbtc("10000"));

        return {
            wallets: { user1, user2 },
            wbtc,
            fund,
            shareP,
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
        wbtc = fixtureData.wbtc;
        fund = fixtureData.fund;
        shareP = fixtureData.shareP;
        primaryMarket = fixtureData.primaryMarket;
    });

    describe("create()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.create(parseWbtc("1"))).to.be.revertedWith(
                "only when active"
            );
        });

        it("Should check minimum creation amount", async function () {
            // TODO this value should be configurable on intialization
            await expect(primaryMarket.create(MIN_CREATION_AMOUNT - 1)).to.be.revertedWith(
                "min amount"
            );
            await primaryMarket.create(MIN_CREATION_AMOUNT);
        });

        it("Should transfer underlying and save the creation", async function () {
            const amount = parseWbtc("1");
            const tx = () => primaryMarket.create(amount);
            await expect(tx).to.changeTokenBalance(wbtc, primaryMarket, amount);
            const cr = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr.creatingUnderlying).to.equal(amount);
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(amount);
        });

        it("Should combine multiple creations in the same day", async function () {
            await primaryMarket.create(parseWbtc("2"));
            await primaryMarket.create(parseWbtc("3"));
            await primaryMarket.connect(user2).create(parseWbtc("4"));
            const cr = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr.creatingUnderlying).to.equal(parseWbtc("5"));
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(parseWbtc("9"));
        });

        it("Should not be claimable in the same day", async function () {
            await primaryMarket.create(parseWbtc("1"));
            // No shares or underlying is transfered
            const tx = () => primaryMarket.claim();
            await expect(tx).to.changeTokenBalances(wbtc, [user1, fund], [0, 0]);
        });

        it("Should emit an event", async function () {
            await expect(primaryMarket.create(parseWbtc("1")))
                .to.emit(primaryMarket, "Created")
                .withArgs(user1.address, parseWbtc("1"));
        });
    });

    describe("redeem()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.redeem(parseEther("1"))).to.be.revertedWith(
                "only when active"
            );
        });

        it("Should revert on zero shares", async function () {
            await expect(primaryMarket.redeem(0)).to.be.revertedWith("Zero shares");
        });

        it("Should transfer shares and save the redemption", async function () {
            const amount = parseEther("1");
            await fund.mock.burn.withArgs(TRANCHE_P, user1.address, amount).returns();
            await fund.mock.mint.withArgs(TRANCHE_P, primaryMarket.address, amount).returns();
            await primaryMarket.redeem(amount);
            const cr = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr.redeemingShares).to.equal(amount);
            expect(await primaryMarket.currentRedeemingShares()).to.equal(amount);
        });

        it("Should combine multiple redemptions in the same day", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("2"));
            await primaryMarket.redeem(parseEther("3"));
            await primaryMarket.connect(user2).redeem(parseEther("4"));
            const cr = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr.redeemingShares).to.equal(parseEther("5"));
            expect(await primaryMarket.currentRedeemingShares()).to.equal(parseEther("9"));
        });

        it("Should not be claimable in the same day", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("1"));
            await fund.mock.burn.revertsWithReason("Mock function reset");
            await fund.mock.mint.revertsWithReason("Mock function reset");
            // No shares or underlying is transfered
            const tx = () => primaryMarket.claim();
            await expect(tx).to.changeTokenBalances(wbtc, [user1, fund], [0, 0]);
        });

        it("Should emit an event", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await expect(primaryMarket.redeem(parseEther("1")))
                .to.emit(primaryMarket, "Redeemed")
                .withArgs(user1.address, parseEther("1"));
        });
    });

    describe("split()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.split(parseEther("1"))).to.be.revertedWith(
                "only when active"
            );
        });

        it("Should revert if too little to split", async function () {
            await expect(primaryMarket.split(1)).to.be.revertedWith("Too little to split");
        });

        it("Should burn and mint shares", async function () {
            // No rounding in this case
            const inP = 10000 * 20;
            const feeP = SPLIT_FEE_BPS * 20;
            const outA = (10000 - SPLIT_FEE_BPS) * 10;
            const outB = (10000 - SPLIT_FEE_BPS) * 10;
            await expect(() => primaryMarket.split(inP)).to.callMocks(
                {
                    func: fund.mock.burn.withArgs(TRANCHE_P, user1.address, inP),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_A, user1.address, outA),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_B, user1.address, outB),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_P, primaryMarket.address, feeP),
                }
            );
        });

        it("Should update fee in shares", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.split(10000 * 10);
            expect(await primaryMarket.currentFeeInShares()).to.equal(SPLIT_FEE_BPS * 10);
        });

        it("Should add unsplittable P shares to fee", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            // The last 1 P share cannot be split and goes to fee
            const inP = 10000 * 20 + 1;
            const feeP = SPLIT_FEE_BPS * 20 + 1;
            await primaryMarket.split(inP);
            expect(await primaryMarket.currentFeeInShares()).to.equal(feeP);
        });

        it("Should emit an event", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await expect(primaryMarket.split(20000))
                .to.emit(primaryMarket, "Split")
                .withArgs(user1.address, 20000, 10000 - SPLIT_FEE_BPS, 10000 - SPLIT_FEE_BPS);
        });
    });

    describe("merge()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.merge(parseEther("1"))).to.be.revertedWith(
                "only when active"
            );
        });

        it("Should revert if too little to merge", async function () {
            await fund.mock.splitWeights.returns(100, 1);
            await expect(primaryMarket.merge(99)).to.be.revertedWith("Too little to merge");
        });

        it("Should burn and mint shares", async function () {
            // No rounding in this case
            const inA = 10000 * 10;
            const inB = 10000 * 10;
            const feeP = MERGE_FEE_BPS * 20;
            const outP = (10000 - MERGE_FEE_BPS) * 20;
            await expect(() => primaryMarket.merge(inA)).to.callMocks(
                {
                    func: fund.mock.burn.withArgs(TRANCHE_A, user1.address, inA),
                },
                {
                    func: fund.mock.burn.withArgs(TRANCHE_B, user1.address, inB),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_P, user1.address, outP),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_P, primaryMarket.address, feeP),
                }
            );
        });

        it("Should update fee in shares", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.merge(50000);
            expect(await primaryMarket.currentFeeInShares()).to.equal(MERGE_FEE_BPS * 10);
        });

        it("Should keeps unmergable A shares unchanged", async function () {
            await fund.mock.splitWeights.returns(100, 200);
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            const reason = "Mock func 'burn A 100' is called";
            await fund.mock.burn.withArgs(TRANCHE_A, user1.address, 100).revertsWithReason(reason);
            await expect(primaryMarket.merge(199)).to.be.revertedWith(reason);
        });

        it("Should emit an event", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await expect(primaryMarket.merge(10000))
                .to.emit(primaryMarket, "Merged")
                .withArgs(user1.address, (10000 - MERGE_FEE_BPS) * 2, 10000, 10000);
        });
    });

    describe("settle()", function () {
        it("Should revert if not called from Fund", async function () {
            await expect(primaryMarket.settle(START_DAY, 0, 0, 1, 1)).to.be.revertedWith(
                "only fund"
            );
        });

        it("Should revert if already settled", async function () {
            await expect(
                fund.call(primaryMarket, "settle", START_DAY - DAY, 0, 0, 1, 1)
            ).to.be.revertedWith("Already settled");
        });

        it("Should succeed when nothing happened and fund was empty", async function () {
            await expect(fund.call(primaryMarket, "settle", START_DAY, 0, 0, 1, 1))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, 0, 0, 0, 0);
            expect(await primaryMarket.currentDay()).to.equal(START_DAY + DAY);
        });

        it("Should settle creation using price and NAV when fund was empty", async function () {
            // Create with 1 WBTC at price 30000 and NAV 0.5
            const inWbtc = parseWbtc("1");
            const feeP = inWbtc.mul(CREATION_FEE_BPS).div(10000);
            const outP = parseEther("60000")
                .mul(10000 - CREATION_FEE_BPS)
                .div(10000);
            await primaryMarket.create(inWbtc);
            await expect(settleWithNav(START_DAY, parseEther("30000"), parseEther("0.5")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, outP, 0, inWbtc, 0, feeP);
            expect(await wbtc.allowance(primaryMarket.address, fund.address)).to.equal(inWbtc);
        });

        it("Should revert if there were shares but fund was empty", async function () {
            await primaryMarket.create(parseWbtc("1"));
            await expect(
                fund.call(primaryMarket, "settle", START_DAY, 1, 0, 1, 1)
            ).to.be.revertedWith("Cannot create shares for fund with shares but no underlying");
        });

        it("Should revert if fund was empty and NAV is zero", async function () {
            await primaryMarket.create(parseWbtc("1"));
            await expect(
                fund.call(primaryMarket, "settle", START_DAY, 0, 0, 1, 0)
            ).to.be.revertedWith("Cannot create shares at zero NAV");
        });

        it("Should settle creation using last shares and underlying", async function () {
            // Fund had 10 WBTC and 10000 shares
            // Create with 1 WBTC
            const inWbtc = parseWbtc("1");
            const feeP = inWbtc.mul(CREATION_FEE_BPS).div(10000);
            const outP = parseEther("1000")
                .mul(10000 - CREATION_FEE_BPS)
                .div(10000);
            await primaryMarket.create(inWbtc);
            await expect(settleWithShare(START_DAY, parseEther("10000"), parseWbtc("10")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, outP, 0, inWbtc, 0, feeP);
            expect(await wbtc.allowance(primaryMarket.address, fund.address)).to.equal(inWbtc);
        });

        it("Should round down creation shares and fee", async function () {
            // Fund had 25 underlying units and 16 share units
            // Create with 9 underlying units
            await primaryMarket.create(9);
            // Fee: 9 * 0.3 = 2
            // Created shares: (9 - 2) * 16 / 25 = 4
            await expect(settleWithShare(START_DAY, 16, 25))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 4, 0, 9, 0, 2);
        });

        it("Should settle redemption using last shares and underlying", async function () {
            // Fund had 10 WBTC and 10000 shares
            // Redeem 1000 shares for 1 WBTC
            const fee = parseWbtc("1").mul(REDEMPTION_FEE_BPS).div(10000);
            const redeemed = parseWbtc("1").sub(fee);
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("1000"));
            await fund.mock.burn.revertsWithReason("Mock function reset");
            await fund.mock.mint.revertsWithReason("Mock function reset");
            await expect(settleWithShare(START_DAY, parseEther("10000"), parseWbtc("10")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, parseEther("1000"), 0, redeemed, fee);
            // No WBTC to be transfered
            expect(await wbtc.allowance(primaryMarket.address, fund.address)).to.equal(0);
        });

        it("Should round down redemption shares and fee", async function () {
            // Fund had 25 underlying units and 9 share units
            // Redeem 7 share units
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(6);
            // Redeemed before fee: 6 * 25 / 9 = 16
            // Fee: 16 * 0.35 = 5
            // Redeemed after fee: 16 - 5 = 11
            await expect(settleWithShare(START_DAY, 9, 25))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, 6, 0, 11, 5);
        });

        it("Should net underlying (creation > redemption)", async function () {
            // Fund had 10 WBTC and 10000 shares
            // Create with 1 WBTC and redeem 1000 shares
            await primaryMarket.create(parseWbtc("1"));
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("1000"));
            const redemptionUnderlying = parseWbtc("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            const net = parseWbtc("1").sub(redemptionUnderlying);
            const tx = await settleWithShare(START_DAY, parseEther("10000"), parseWbtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.creationUnderlying).to.equal(parseWbtc("1"));
            expect(event.redemptionUnderlying).to.equal(redemptionUnderlying);
            expect(await wbtc.allowance(primaryMarket.address, fund.address)).to.equal(net);
        });

        it("Should net underlying (creation < redemption)", async function () {
            // Fund had 10 WBTC and 10000 shares
            // Create with 1 WBTC and redeem all the 10000 shares
            await primaryMarket.create(parseWbtc("1"));
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("10000"));
            const redemptionUnderlying = parseWbtc("10")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            const tx = await settleWithShare(START_DAY, parseEther("10000"), parseWbtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.creationUnderlying).to.equal(parseWbtc("1"));
            expect(event.redemptionUnderlying).to.equal(redemptionUnderlying);
            // No WBTC to be transfered
            expect(await wbtc.allowance(primaryMarket.address, fund.address)).to.equal(0);
        });

        it("Should settle split and merge fee", async function () {
            // Fund had 10 WBTC and 10000 shares
            // Split 1000 P and merge 100 A and 100 B
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.split(parseEther("1000"));
            await primaryMarket.connect(user2).merge(parseEther("100"));
            const splitFee = parseEther("1000").mul(SPLIT_FEE_BPS).div(10000);
            const mergeFee = parseEther("200").mul(MERGE_FEE_BPS).div(10000);
            const feeInShares = splitFee.add(mergeFee);
            const feeInWbtc = feeInShares.mul(parseWbtc("10")).div(parseEther("10000"));
            await expect(settleWithShare(START_DAY, parseEther("10000"), parseWbtc("10")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, feeInShares, 0, 0, feeInWbtc);
            // No WBTC to be transfered
            expect(await wbtc.allowance(primaryMarket.address, fund.address)).to.equal(0);
        });

        it("Should settle everything together", async function () {
            // Fund had 10 WBTC and 10000 shares
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            // Create with 1 WBTC
            await primaryMarket.connect(user2).create(parseWbtc("1"));
            const createdShares = parseEther("1000")
                .mul(10000 - CREATION_FEE_BPS)
                .div(10000);
            const creationFee = parseWbtc("1").mul(CREATION_FEE_BPS).div(10000);
            // Redeem 1000 shares
            await primaryMarket.redeem(parseEther("1000"));
            const redemptionFee = parseWbtc("1").mul(REDEMPTION_FEE_BPS).div(10000);
            const redeemedWbtc = parseWbtc("1").sub(redemptionFee);
            // Split 1000 P and merge 100 A and 100 B
            await primaryMarket.split(parseEther("1000"));
            await primaryMarket.connect(user2).merge(parseEther("100"));
            const splitFee = parseEther("1000").mul(SPLIT_FEE_BPS).div(10000);
            const mergeFee = parseEther("200").mul(MERGE_FEE_BPS).div(10000);
            const feeInShares = splitFee.add(mergeFee);
            const feeInWbtc = feeInShares.mul(parseWbtc("10")).div(parseEther("10000"));
            const tx = await settleWithShare(START_DAY, parseEther("10000"), parseWbtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.sharesToMint).to.equal(createdShares);
            expect(event.sharesToBurn).to.equal(parseEther("1000").add(feeInShares));
            expect(event.creationUnderlying).to.equal(parseWbtc("1"));
            expect(event.redemptionUnderlying).to.equal(redeemedWbtc);
            expect(event.fee).to.equal(creationFee.add(redemptionFee).add(feeInWbtc));
            // Net underlying (creation - redemption) to be transfered to fund
            const netWbtc = parseWbtc("1").sub(redeemedWbtc);
            expect(await wbtc.allowance(primaryMarket.address, fund.address)).to.equal(netWbtc);
        });
    });

    describe("claim()", function () {
        let outerFixture: Fixture<FixtureData>;
        let createdShares: BigNumber;
        let redeemedWbtc: BigNumber;

        interface SettleFixtureData extends FixtureData {
            createdShares: BigNumber;
            redeemedWbtc: BigNumber;
        }

        async function settleFixture(): Promise<SettleFixtureData> {
            const f = await loadFixture(deployFixture);
            await f.fund.mock.getConversionSize.returns(0);
            await f.fund.mock.burn.returns();
            await f.fund.mock.mint.returns();
            await f.primaryMarket.create(parseWbtc("1"));
            await f.primaryMarket.redeem(parseEther("1000"));
            await f.fund.call(
                f.primaryMarket,
                "settle",
                START_DAY,
                parseEther("10000"),
                parseWbtc("10"),
                0,
                0
            );
            const createdShares = parseEther("1000")
                .mul(10000 - CREATION_FEE_BPS)
                .div(10000);
            const redeemedWbtc = parseWbtc("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            return { createdShares, redeemedWbtc, ...f };
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
            createdShares = f.createdShares;
            redeemedWbtc = f.redeemedWbtc;
        });

        it("Should transfer created shares", async function () {
            await expect(() => primaryMarket.claim()).to.callMocks({
                func: shareP.mock.transfer.withArgs(user1.address, createdShares),
                rets: [true],
            });
        });

        it("Should transfer redeemed underlying", async function () {
            await shareP.mock.transfer.returns(true);
            await expect(() => primaryMarket.claim()).to.changeTokenBalances(
                wbtc,
                [user1, primaryMarket],
                [redeemedWbtc, redeemedWbtc.mul(-1)]
            );
        });

        it("Should combine claimable creations in different days", async function () {
            await primaryMarket.create(parseWbtc("4"));
            // Day (START_DAY + DAY) is not settled
            await settleWithShare(START_DAY + DAY * 2, parseEther("20000"), parseWbtc("40"));
            const createdAgain = parseEther("2000")
                .mul(10000 - CREATION_FEE_BPS)
                .div(10000);
            await expect(() => primaryMarket.claim()).to.callMocks({
                func: shareP.mock.transfer.withArgs(user1.address, createdShares.add(createdAgain)),
                rets: [true],
            });
        });

        it("Should combine claimable redemptions in different days", async function () {
            await primaryMarket.redeem(parseEther("2000"));
            // Day (START_DAY + DAY) is not settled
            await settleWithShare(START_DAY + DAY * 2, parseEther("20000"), parseWbtc("40"));
            const redeemedAgain = parseWbtc("4")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            // Fund should transfer redeemed underlying after settlement
            await wbtc.mint(primaryMarket.address, redeemedAgain);
            const total = redeemedWbtc.add(redeemedAgain);
            await shareP.mock.transfer.returns(true);
            await expect(() => primaryMarket.claim()).to.changeTokenBalances(
                wbtc,
                [user1, primaryMarket],
                [total, total.mul(-1)]
            );
        });

        it("Should convert claimable shares on new creation", async function () {
            await fund.mock.getConversionSize.returns(3);
            await expect(() => primaryMarket.create(parseWbtc("4"))).to.callMocks({
                func: fund.mock.batchConvert.withArgs(createdShares, 0, 0, 0, 3),
                rets: [parseEther("300"), 0, 0],
            });
            const cr = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr.createdShares).to.equal(parseEther("300"));
            expect(cr.conversionIndex).to.equal(3);
            // No conversion function is called this time
            await primaryMarket.create(parseWbtc("6"));
            const cr2 = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr2.createdShares).to.equal(parseEther("300"));
            expect(cr2.conversionIndex).to.equal(3);
        });

        it("Should convert claimable shares on new redemption", async function () {
            await fund.mock.getConversionSize.returns(5);
            await expect(() => primaryMarket.redeem(parseEther("2000"))).to.callMocks({
                func: fund.mock.batchConvert.withArgs(createdShares, 0, 0, 0, 5),
                rets: [parseEther("800"), 0, 0],
            });
            const cr = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr.createdShares).to.equal(parseEther("800"));
            expect(cr.conversionIndex).to.equal(5);
            // No conversion function is called this time
            await primaryMarket.redeem(parseEther("3000"));
            const cr2 = await primaryMarket.creationRedemptionOf(user1.address);
            expect(cr2.createdShares).to.equal(parseEther("800"));
            expect(cr2.conversionIndex).to.equal(5);
        });

        it("Should convert claimable shares on claim", async function () {
            await fund.mock.getConversionSize.returns(1);
            await expect(() => primaryMarket.claim()).to.callMocks(
                {
                    func: fund.mock.batchConvert.withArgs(createdShares, 0, 0, 0, 1),
                    rets: [parseEther("7000"), 0, 0],
                },
                {
                    func: shareP.mock.transfer.withArgs(user1.address, parseEther("7000")),
                    rets: [true],
                }
            );
        });
    });
});
