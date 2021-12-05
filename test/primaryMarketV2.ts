import { AssertionError, expect } from "chai";
import { BigNumber, Contract, Transaction, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
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
        readonly fund: Contract;
        readonly shareM: Contract;
        readonly primaryMarket: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let btc: Contract;
    let fund: Contract;
    let shareM: Contract;
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
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        const fund = await deployMockForName(owner, "FundV2");
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
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV2");
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
        owner = fixtureData.wallets.owner;
        btc = fixtureData.btc;
        fund = fixtureData.fund;
        shareM = fixtureData.shareM;
        primaryMarket = fixtureData.primaryMarket;
    });

    describe("create()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.create(parseBtc("1"))).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should check minimum creation amount", async function () {
            await expect(primaryMarket.create(MIN_CREATION_AMOUNT - 1)).to.be.revertedWith(
                "Min amount"
            );
            await primaryMarket.create(MIN_CREATION_AMOUNT);
        });

        it("Should transfer underlying and save the creation", async function () {
            const amount = parseBtc("1");
            const tx = () => primaryMarket.create(amount);
            await expect(tx).to.changeTokenBalance(btc, primaryMarket, amount);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr.creatingUnderlying).to.equal(amount);
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(amount);
        });

        it("Should combine multiple creations in the same day", async function () {
            await primaryMarket.create(parseBtc("2"));
            await primaryMarket.create(parseBtc("3"));
            await primaryMarket.connect(user2).create(parseBtc("4"));
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr.creatingUnderlying).to.equal(parseBtc("5"));
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(parseBtc("9"));
        });

        it("Should not be claimable in the same day", async function () {
            await primaryMarket.create(parseBtc("1"));
            // No shares or underlying is transfered
            const tx = () => primaryMarket.claim(user1.address);
            await expect(tx).to.changeTokenBalances(btc, [user1, fund], [0, 0]);
        });

        it("Should emit an event", async function () {
            await expect(primaryMarket.create(parseBtc("1")))
                .to.emit(primaryMarket, "Created")
                .withArgs(user1.address, parseBtc("1"));
        });
    });

    describe("redeem()", function () {
        it("Should check activeness", async function () {
            await fund.mock.isPrimaryMarketActive.returns(false);
            await expect(primaryMarket.redeem(parseEther("1"))).to.be.revertedWith(
                "Only when active"
            );
        });

        it("Should revert on zero shares", async function () {
            await expect(primaryMarket.redeem(0)).to.be.revertedWith("Zero shares");
        });

        it("Should transfer shares and save the redemption", async function () {
            const amount = parseEther("1");
            await fund.mock.burn.withArgs(TRANCHE_M, user1.address, amount).returns();
            await fund.mock.mint.withArgs(TRANCHE_M, primaryMarket.address, amount).returns();
            await primaryMarket.redeem(amount);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr.redeemingShares).to.equal(amount);
            expect(await primaryMarket.currentRedeemingShares()).to.equal(amount);
        });

        it("Should combine multiple redemptions in the same day", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("2"));
            await primaryMarket.redeem(parseEther("3"));
            await primaryMarket.connect(user2).redeem(parseEther("4"));
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
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
            const tx = () => primaryMarket.claim(user1.address);
            await expect(tx).to.changeTokenBalances(btc, [user1, fund], [0, 0]);
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
                "Only when active"
            );
        });

        it("Should revert if too little to split", async function () {
            await expect(primaryMarket.split(1)).to.be.revertedWith("Too little to split");
        });

        it("Should burn and mint shares", async function () {
            // No rounding in this case
            const inM = 10000 * 20;
            const feeM = SPLIT_FEE_BPS * 20;
            const outA = (10000 - SPLIT_FEE_BPS) * 10;
            const outB = (10000 - SPLIT_FEE_BPS) * 10;
            await expect(() => primaryMarket.split(inM)).to.callMocks(
                {
                    func: fund.mock.burn.withArgs(TRANCHE_M, user1.address, inM),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_A, user1.address, outA),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_B, user1.address, outB),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_M, primaryMarket.address, feeM),
                }
            );
        });

        it("Should update fee in shares", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.split(10000 * 10);
            expect(await primaryMarket.currentFeeInShares()).to.equal(SPLIT_FEE_BPS * 10);
        });

        it("Should add unsplittable M shares to fee", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            // The last 1 Token M cannot be split and goes to fee
            const inM = 10000 * 20 + 1;
            const feeM = SPLIT_FEE_BPS * 20 + 1;
            await primaryMarket.split(inM);
            expect(await primaryMarket.currentFeeInShares()).to.equal(feeM);
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
                "Only when active"
            );
        });

        it("Should revert if too little to merge", async function () {
            await fund.mock.trancheWeights.returns(100, 1);
            await expect(primaryMarket.merge(99)).to.be.revertedWith("Too little to merge");
        });

        it("Should burn and mint shares", async function () {
            // No rounding in this case
            const inA = 10000 * 10;
            const inB = 10000 * 10;
            const feeM = MERGE_FEE_BPS * 20;
            const outM = (10000 - MERGE_FEE_BPS) * 20;
            await expect(() => primaryMarket.merge(inA)).to.callMocks(
                {
                    func: fund.mock.burn.withArgs(TRANCHE_A, user1.address, inA),
                },
                {
                    func: fund.mock.burn.withArgs(TRANCHE_B, user1.address, inB),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_M, user1.address, outM),
                },
                {
                    func: fund.mock.mint.withArgs(TRANCHE_M, primaryMarket.address, feeM),
                }
            );
        });

        it("Should update fee in shares", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.merge(50000);
            expect(await primaryMarket.currentFeeInShares()).to.equal(MERGE_FEE_BPS * 10);
        });

        it("Should keeps unmergable Token A unchanged", async function () {
            await fund.mock.trancheWeights.returns(100, 200);
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await expect(() => primaryMarket.merge(199)).to.callMocks({
                func: fund.mock.burn.withArgs(TRANCHE_A, user1.address, 100),
            });
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
                "Only fund"
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
            // Create with 1 BTC at price 30000 and NAV 0.5
            const inBtc = parseBtc("1");
            const outM = parseEther("60000");
            await primaryMarket.create(inBtc);
            await expect(settleWithNav(START_DAY, parseEther("30000"), parseEther("0.5")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, outM, 0, inBtc, 0, 0);
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(inBtc);
        });

        it("Should revert if there were shares but fund was empty", async function () {
            await primaryMarket.create(parseBtc("1"));
            await expect(
                fund.call(primaryMarket, "settle", START_DAY, 1, 0, 1, 1)
            ).to.be.revertedWith("Cannot create shares for fund with shares but no underlying");
        });

        it("Should revert if fund was empty and NAV is zero", async function () {
            await primaryMarket.create(parseBtc("1"));
            await expect(
                fund.call(primaryMarket, "settle", START_DAY, 0, 0, 1, 0)
            ).to.be.revertedWith("Cannot create shares at zero NAV");
        });

        it("Should settle creation using last shares and underlying", async function () {
            // Fund had 10 BTC and 10000 shares
            // Create with 1 BTC
            const inBtc = parseBtc("1");
            const outM = parseEther("1000");
            await primaryMarket.create(inBtc);
            await expect(settleWithShare(START_DAY, parseEther("10000"), parseBtc("10")))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, outM, 0, inBtc, 0, 0);
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(inBtc);
        });

        it("Should round down creation shares and fee", async function () {
            // Fund had 25 underlying units and 16 share units
            // Create with 9 underlying units
            await primaryMarket.create(9);
            // Fee: 0
            // Created shares: 9 * 16 / 25 = 5
            await expect(settleWithShare(START_DAY, 16, 25))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 5, 0, 9, 0, 0);
        });

        it("Should settle redemption using last shares and underlying", async function () {
            // Fund had 10 BTC and 10000 shares
            // Redeem 1000 shares for 1 BTC
            const fee = parseBtc("1").mul(REDEMPTION_FEE_BPS).div(10000);
            const redeemed = parseBtc("1").sub(fee);
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("1000"));
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
            await primaryMarket.redeem(600);
            // Redeemed before fee: 600 * 2500 / 900 = 1666
            // Fee: 1666 * 0.0035 = 5
            // Redeemed after fee: 1666 - 5 = 1661
            await expect(settleWithShare(START_DAY, 900, 2500))
                .to.emit(primaryMarket, "Settled")
                .withArgs(START_DAY, 0, 600, 0, 1661, 5);
        });

        it("Should net underlying (creation > redemption)", async function () {
            // Fund had 10 BTC and 10000 shares
            // Create with 1 BTC and redeem 1000 shares
            await primaryMarket.create(parseBtc("1"));
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("1000"));
            const redemptionUnderlying = parseBtc("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            const net = parseBtc("1").sub(redemptionUnderlying);
            const tx = await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.creationUnderlying).to.equal(parseBtc("1"));
            expect(event.redemptionUnderlying).to.equal(redemptionUnderlying);
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(net);
        });

        it("Should net underlying (creation < redemption)", async function () {
            // Fund had 10 BTC and 10000 shares
            // Create with 1 BTC and redeem all the 10000 shares
            await primaryMarket.create(parseBtc("1"));
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("10000"));
            const redemptionUnderlying = parseBtc("10")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            const tx = await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.creationUnderlying).to.equal(parseBtc("1"));
            expect(event.redemptionUnderlying).to.equal(redemptionUnderlying);
            // No BTC to be transfered
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(0);
        });

        it("Should settle split and merge fee", async function () {
            // Fund had 10 BTC and 10000 shares
            // Split 1000 M and merge 100 A and 100 B
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.split(parseEther("1000"));
            await primaryMarket.connect(user2).merge(parseEther("100"));
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
            // Create with 1 BTC
            await primaryMarket.connect(user2).create(parseBtc("1"));
            const createdShares = parseEther("1000");
            // Redeem 1000 shares
            await primaryMarket.redeem(parseEther("1000"));
            const redemptionFee = parseBtc("1").mul(REDEMPTION_FEE_BPS).div(10000);
            const redeemedBtc = parseBtc("1").sub(redemptionFee);
            // Split 1000 M and merge 100 A and 100 B
            await primaryMarket.split(parseEther("1000"));
            await primaryMarket.connect(user2).merge(parseEther("100"));
            const splitFee = parseEther("1000").mul(SPLIT_FEE_BPS).div(10000);
            const mergeFee = parseEther("200").mul(MERGE_FEE_BPS).div(10000);
            const feeInShares = splitFee.add(mergeFee);
            const feeInBtc = feeInShares.mul(parseBtc("10")).div(parseEther("10000"));
            const tx = await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            const event = await parseEvent(tx, primaryMarket, "Settled");
            expect(event.sharesToMint).to.equal(createdShares);
            expect(event.sharesToBurn).to.equal(parseEther("1000").add(feeInShares));
            expect(event.creationUnderlying).to.equal(parseBtc("1"));
            expect(event.redemptionUnderlying).to.equal(redeemedBtc);
            expect(event.fee).to.equal(redemptionFee.add(feeInBtc));
            // Net underlying (creation - redemption) to be transfered to fund
            const netBtc = parseBtc("1").sub(redeemedBtc);
            expect(await btc.allowance(primaryMarket.address, fund.address)).to.equal(netBtc);
        });
    });

    describe("claim()", function () {
        let outerFixture: Fixture<FixtureData>;
        let createdShares: BigNumber;
        let redeemedBtc: BigNumber;

        interface SettleFixtureData extends FixtureData {
            createdShares: BigNumber;
            redeemedBtc: BigNumber;
        }

        async function settleFixture(): Promise<SettleFixtureData> {
            const f = await loadFixture(deployFixture);
            await f.fund.mock.getRebalanceSize.returns(0);
            await f.fund.mock.burn.returns();
            await f.fund.mock.mint.returns();
            await f.primaryMarket.create(parseBtc("1"));
            await f.primaryMarket.redeem(parseEther("1000"));
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
                "transferFrom",
                f.primaryMarket.address,
                f.fund.address,
                parseBtc("1").mul(REDEMPTION_FEE_BPS).div(10000)
            );
            const createdShares = parseEther("1000");
            const redeemedBtc = parseBtc("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            return { createdShares, redeemedBtc, ...f };
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
            redeemedBtc = f.redeemedBtc;
        });

        it("Should transfer created shares", async function () {
            await expect(() => primaryMarket.claim(user1.address)).to.callMocks({
                func: shareM.mock.transfer.withArgs(user1.address, createdShares),
                rets: [true],
            });
        });

        it("Should transfer redeemed underlying", async function () {
            await shareM.mock.transfer.returns(true);
            await expect(() => primaryMarket.claim(user1.address)).to.changeTokenBalances(
                btc,
                [user1, primaryMarket],
                [redeemedBtc, redeemedBtc.mul(-1)]
            );
        });

        it("Should combine claimable creations in different days", async function () {
            await primaryMarket.create(parseBtc("4"));
            // Day (START_DAY + DAY) is not settled
            await settleWithShare(START_DAY + DAY * 2, parseEther("20000"), parseBtc("40"));
            const createdAgain = parseEther("2000");
            await expect(() => primaryMarket.claim(user1.address)).to.callMocks({
                func: shareM.mock.transfer.withArgs(user1.address, createdShares.add(createdAgain)),
                rets: [true],
            });
        });

        it("Should combine claimable redemptions in different days", async function () {
            await primaryMarket.redeem(parseEther("2000"));
            // Day (START_DAY + DAY) is not settled
            await settleWithShare(START_DAY + DAY * 2, parseEther("20000"), parseBtc("40"));
            const redeemedAgain = parseBtc("4")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            // Fund should transfer redeemed underlying after settlement
            await btc.mint(primaryMarket.address, redeemedAgain);
            const total = redeemedBtc.add(redeemedAgain);
            await shareM.mock.transfer.returns(true);
            await expect(() => primaryMarket.claim(user1.address)).to.changeTokenBalances(
                btc,
                [user1, primaryMarket],
                [total, total.mul(-1)]
            );
        });

        it("Should rebalance claimable shares on new creation", async function () {
            await fund.mock.getRebalanceSize.returns(3);
            await expect(() => primaryMarket.create(parseBtc("4"))).to.callMocks({
                func: fund.mock.batchRebalance.withArgs(createdShares, 0, 0, 0, 3),
                rets: [parseEther("300"), 0, 0],
            });
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr.createdShares).to.equal(parseEther("300"));
            expect(cr.version).to.equal(3);
            // No rebalance function is called this time
            await primaryMarket.create(parseBtc("6"));
            const cr2 = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr2.createdShares).to.equal(parseEther("300"));
            expect(cr2.version).to.equal(3);
        });

        it("Should rebalance claimable shares on new redemption", async function () {
            await fund.mock.getRebalanceSize.returns(5);
            await expect(() => primaryMarket.redeem(parseEther("2000"))).to.callMocks({
                func: fund.mock.batchRebalance.withArgs(createdShares, 0, 0, 0, 5),
                rets: [parseEther("800"), 0, 0],
            });
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr.createdShares).to.equal(parseEther("800"));
            expect(cr.version).to.equal(5);
            // No rebalance function is called this time
            await primaryMarket.redeem(parseEther("3000"));
            const cr2 = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr2.createdShares).to.equal(parseEther("800"));
            expect(cr2.version).to.equal(5);
        });

        it("Should rebalance claimable shares on claim", async function () {
            await fund.mock.getRebalanceSize.returns(1);
            await expect(() => primaryMarket.claim(user1.address)).to.callMocks(
                {
                    func: fund.mock.batchRebalance.withArgs(createdShares, 0, 0, 0, 1),
                    rets: [parseEther("7000"), 0, 0],
                },
                {
                    func: shareM.mock.transfer.withArgs(user1.address, parseEther("7000")),
                    rets: [true],
                }
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

        async function claim(user: Wallet): Promise<void> {
            await primaryMarket.claim(user.address);
        }

        beforeEach(async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.connect(user1).redeem(parseEther("1000"));
            await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            await primaryMarket.connect(user1).redeem(parseEther("500"));
            await primaryMarket.connect(user2).redeem(parseEther("2000"));
            await settleWithShare(START_DAY + DAY, parseEther("9000"), parseBtc("9"));
            await settleWithShare(START_DAY + DAY * 2, parseEther("6500"), parseBtc("6.5"));
            await primaryMarket.connect(user1).redeem(parseEther("1500"));
            await primaryMarket.connect(user2).redeem(parseEther("3000"));
            await settleWithShare(START_DAY + DAY * 3, parseEther("6500"), parseBtc("6.5"));
            await primaryMarket.connect(user1).redeem(parseEther("200"));
            await primaryMarket.connect(user2).redeem(parseEther("300"));
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
            await primaryMarket.claim(user1.address);
            await primaryMarket.connect(user2).redeem(parseEther("1"));
            expect(await getter(user1, START_DAY + DAY * 3)).to.eql([btcU1D3, START_DAY + DAY * 4]);
            expect(await getter(user2, START_DAY + DAY * 3)).to.eql([btcU2D3, START_DAY + DAY * 4]);
            expect(await getter(user1, START_DAY + DAY * 4)).to.eql([btcU1D4, 0]);
            expect(await getter(user2, START_DAY + DAY * 4)).to.eql([btcU2D4, 0]);
        });

        it("getDelayedRedemptionHead()", async function () {
            expect(await primaryMarket.getDelayedRedemptionHead(user1.address)).to.equal(START_DAY);
            expect(await primaryMarket.getDelayedRedemptionHead(user2.address)).to.equal(
                START_DAY + DAY
            );
        });

        it("updateDelayedRedemptionDay()", async function () {
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY);
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY);

            await primaryMarket.connect(user2).create(btcU1D0);
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY);

            await btc.mint(primaryMarket.address, btcU1D1.add(btcU2D1).sub(parseBtc("0.0001")));
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY);

            await btc.mint(primaryMarket.address, parseBtc("0.0001"));
            await primaryMarket.updateDelayedRedemptionDay();
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY * 3);
        });

        it("Should be claimable after the contract has enough tokens", async function () {
            await btc.mint(
                primaryMarket.address,
                btcU1D0.add(btcU1D1).add(btcU2D1).sub(parseBtc("0.001"))
            );
            await expect(() => primaryMarket.claim(user1.address)).to.changeTokenBalance(
                btc,
                user1,
                btcU1D0
            );
            await expect(() => primaryMarket.claim(user2.address)).to.changeTokenBalance(
                btc,
                user2,
                0
            );
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY);
            expect(await primaryMarket.getDelayedRedemptionHead(user1.address)).to.equal(
                START_DAY + DAY
            );
            expect(await primaryMarket.getDelayedRedemptionHead(user2.address)).to.equal(
                START_DAY + DAY
            );

            await primaryMarket.connect(user1).create(btcU1D3.add(btcU2D3).add(parseBtc("0.005")));
            await expect(() => primaryMarket.claim(user1.address)).to.changeTokenBalance(
                btc,
                user1,
                btcU1D1.add(btcU1D3)
            );
            await expect(() => primaryMarket.claim(user2.address)).to.changeTokenBalance(
                btc,
                user2,
                btcU2D1.add(btcU2D3)
            );
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY * 4);
            expect(await primaryMarket.getDelayedRedemptionHead(user1.address)).to.equal(
                START_DAY + DAY * 4
            );
            expect(await primaryMarket.getDelayedRedemptionHead(user2.address)).to.equal(
                START_DAY + DAY * 4
            );

            await btc.mint(primaryMarket.address, btcU1D4.add(btcU2D4));
            await expect(() => primaryMarket.claim(user1.address)).to.changeTokenBalance(
                btc,
                user1,
                btcU1D4
            );
            await expect(() => primaryMarket.claim(user2.address)).to.changeTokenBalance(
                btc,
                user2,
                btcU2D4
            );
            expect(await primaryMarket.delayedRedemptionDay()).to.equal(START_DAY + DAY * 5);
            expect(await primaryMarket.getDelayedRedemptionHead(user1.address)).to.equal(0);
            expect(await primaryMarket.getDelayedRedemptionHead(user2.address)).to.equal(0);
        });
    });

    describe("Actions after rebalance", function () {
        beforeEach(async function () {
            await fund.mock.getRebalanceSize.returns(3);
            await btc.mint(fund.address, parseBtc("10"));
        });

        it("Should always return the latest version", async function () {
            expect(
                (await primaryMarket.callStatic.creationRedemptionOf(user1.address)).version
            ).to.equal(3);
        });

        it("Should update version on creation", async function () {
            await primaryMarket.create(parseBtc("1"));
            expect(
                (await primaryMarket.callStatic.creationRedemptionOf(user1.address))
                    .creatingUnderlying
            ).to.equal(parseBtc("1"));

            await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            await fund.call(
                btc,
                "transferFrom",
                primaryMarket.address,
                fund.address,
                parseBtc("1")
            );
            expect(
                (await primaryMarket.callStatic.creationRedemptionOf(user1.address)).createdShares
            ).to.equal(parseEther("1000"));
            await expect(() => primaryMarket.claim(user1.address)).to.callMocks({
                func: shareM.mock.transfer.withArgs(user1.address, parseEther("1000")),
                rets: [true],
            });
        });

        it("Should update version on redemption", async function () {
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.redeem(parseEther("1000"));
            expect(
                (await primaryMarket.callStatic.creationRedemptionOf(user1.address)).redeemingShares
            ).to.equal(parseEther("1000"));

            await settleWithShare(START_DAY, parseEther("10000"), parseBtc("10"));
            const redeemedBtc = parseBtc("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            await fund.call(btc, "transfer", primaryMarket.address, redeemedBtc);
            expect(
                (await primaryMarket.callStatic.creationRedemptionOf(user1.address))
                    .redeemedUnderlying
            ).to.equal(redeemedBtc);
            await expect(() => primaryMarket.claim(user1.address)).to.changeTokenBalances(
                btc,
                [user1, primaryMarket],
                [redeemedBtc, redeemedBtc.mul(-1)]
            );
        });
    });

    describe("Fund cap", function () {
        beforeEach(async function () {
            const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV2");
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
            await expect(primaryMarket.connect(user1).create(parseBtc("1"))).to.be.revertedWith(
                "Exceed fund cap"
            );
        });

        it("Should revert when creation amount exceeds total cap", async function () {
            await primaryMarket.connect(owner).updateFundCap(parseBtc("1"));
            await fund.mock.historicalUnderlying.withArgs(START_DAY - DAY).returns(parseBtc("0.2"));

            await primaryMarket.create(parseBtc("0.6"));
            await expect(primaryMarket.connect(user2).create(parseBtc("0.3"))).to.be.revertedWith(
                "Exceed fund cap"
            );
            await primaryMarket.create(parseBtc("0.2"));
        });
    });

    describe("Wrapped native currency", function () {
        let weth: Contract;

        beforeEach(async function () {
            const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
            weth = await MockWrappedToken.connect(owner).deploy("Wrapped ETH", "ETH");
            weth = weth.connect(user1);
            await fund.mock.tokenUnderlying.returns(weth.address);
            const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV2");
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
            await expect(() =>
                primaryMarket.wrapAndCreate({ value: amount })
            ).to.changeEtherBalance(user1, amount.mul(-1));
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(amount);
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr.creatingUnderlying).to.equal(amount);
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(amount);
        });

        it("Mixed creation", async function () {
            await primaryMarket.wrapAndCreate({ value: parseEther("3") });
            await weth.deposit({ value: parseEther("4") });
            await weth.approve(primaryMarket.address, parseEther("4"));
            await primaryMarket.create(parseEther("4"));
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(parseEther("7"));
            const cr = await primaryMarket.callStatic.creationRedemptionOf(user1.address);
            expect(cr.creatingUnderlying).to.equal(parseEther("7"));
            expect(await primaryMarket.currentCreatingUnderlying()).to.equal(parseEther("7"));
        });

        it("claimAndUnwrap() for redemption", async function () {
            await weth.connect(owner).deposit({ value: parseEther("999") });
            await weth.connect(owner).transfer(primaryMarket.address, parseEther("999"));
            await fund.mock.burn.returns();
            await fund.mock.mint.returns();
            await primaryMarket.connect(user1).redeem(parseEther("1000"));
            await settleWithShare(START_DAY, parseEther("10000"), parseEther("10"));

            const redeemed = parseEther("1")
                .mul(10000 - REDEMPTION_FEE_BPS)
                .div(10000);
            await expect(() => primaryMarket.claimAndUnwrap(user1.address)).to.changeEtherBalance(
                user1,
                redeemed
            );
            expect(await weth.balanceOf(primaryMarket.address)).to.equal(
                parseEther("999").sub(redeemed)
            );
        });

        it("claimAndUnwrap() for creation", async function () {
            await primaryMarket.connect(user1).wrapAndCreate({ value: parseEther("1") });
            await settleWithShare(START_DAY, parseEther("10000"), parseEther("10"));
            const nativeBalance = await user1.getBalance();
            // Pay gas fee from another address
            await expect(() =>
                primaryMarket.connect(user2).claimAndUnwrap(user1.address)
            ).to.callMocks({
                func: shareM.mock.transfer.withArgs(user1.address, parseEther("1000")),
                rets: [true],
            });
            expect(await user1.getBalance()).to.equal(nativeBalance);
        });
    });
});
