import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider, Stub } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "../mock";
import {
    TRANCHE_M,
    TRANCHE_A,
    TRANCHE_B,
    DAY,
    HOUR,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";

const POST_REBALANCE_DELAY_TIME = HOUR * 12;
const DAILY_PROTOCOL_FEE_BPS = 1; // 0.01% per day, 3.65% per year
const UPPER_REBALANCE_THRESHOLD = parseEther("2");
const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");
const STRATEGY_UPDATE_MIN_DELAY = DAY * 3;
const STRATEGY_UPDATE_MAX_DELAY = DAY * 7;

describe("FundV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startDay: number;
        readonly startTimestamp: number;
        readonly twapOracle: MockContract;
        readonly btc: Contract;
        readonly aprOracle: MockContract;
        readonly interestRateBallot: MockContract;
        readonly primaryMarket: MockContract;
        readonly fund: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startDay: number;
    let startTimestamp: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let shareM: Wallet;
    let shareA: Wallet;
    let shareB: Wallet;
    let feeCollector: Wallet;
    let strategy: Wallet;
    let addr1: string;
    let addr2: string;
    let twapOracle: MockContract;
    let btc: Contract;
    let aprOracle: MockContract;
    let interestRateBallot: MockContract;
    let primaryMarket: MockContract;
    let fund: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        // Initiating transactions from a Waffle mock contract doesn't work well in Hardhat
        // and may fail with gas estimating errors. We use EOAs for the shares to make
        // test development easier.
        const [user1, user2, owner, shareM, shareA, shareB, feeCollector, strategy] =
            provider.getWallets();

        // Start at 12 hours after settlement time of the 6th day in a week, which makes sure that
        // the first settlement after the fund's deployment settles the last day in a week and
        // starts a new week by updating interest rate of Token A. Many test cases in this file
        // rely on this fact to change the interest rate.
        //
        // As Fund settles at 14:00 everyday and an Unix timestamp starts a week on Thursday,
        // the test cases starts at 2:00 on Thursday (`startTimestamp`) and the first day settles
        // at 14:00 on Thursday (`startDay`).
        let startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const lastDay = Math.ceil(startTimestamp / DAY / 7) * DAY * 7 + DAY * 6 + SETTLEMENT_TIME;
        const startDay = lastDay + DAY;
        startTimestamp = lastDay + 3600 * 12;
        await advanceBlockAtTime(startTimestamp);

        const twapOracle = await deployMockForName(owner, "ITwapOracle");
        await twapOracle.mock.getTwap.withArgs(lastDay).returns(parseEther("1000"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);

        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day

        const interestRateBallot = await deployMockForName(owner, "IBallot");
        await interestRateBallot.mock.count.returns(0);

        const primaryMarket = await deployMockForName(owner, "IPrimaryMarketV2");

        const Fund = await ethers.getContractFactory("FundV2");
        const fund = await Fund.connect(owner).deploy(
            btc.address,
            8,
            parseEther("0.0001").mul(DAILY_PROTOCOL_FEE_BPS),
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            interestRateBallot.address,
            feeCollector.address
        );
        await primaryMarket.call(btc, "approve", fund.address, BigNumber.from("2").pow(256).sub(1));

        await fund.initialize(
            shareM.address,
            shareA.address,
            shareB.address,
            primaryMarket.address,
            ethers.constants.AddressZero
        );

        return {
            wallets: { user1, user2, owner, shareM, shareA, shareB, feeCollector, strategy },
            startDay,
            startTimestamp,
            twapOracle,
            btc,
            aprOracle,
            interestRateBallot,
            primaryMarket,
            fund: fund.connect(user1),
        };
    }

    async function advanceOneDayAndSettle() {
        await advanceBlockAtTime((await fund.currentDay()).toNumber());
        await fund.settle();
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        owner = fixtureData.wallets.owner;
        shareM = fixtureData.wallets.shareM;
        shareA = fixtureData.wallets.shareA;
        shareB = fixtureData.wallets.shareB;
        feeCollector = fixtureData.wallets.feeCollector;
        strategy = fixtureData.wallets.strategy;
        addr1 = user1.address;
        addr2 = user2.address;
        startDay = fixtureData.startDay;
        startTimestamp = fixtureData.startTimestamp;
        twapOracle = fixtureData.twapOracle;
        btc = fixtureData.btc;
        aprOracle = fixtureData.aprOracle;
        interestRateBallot = fixtureData.interestRateBallot;
        primaryMarket = fixtureData.primaryMarket;
        fund = fixtureData.fund;
    });

    describe("endOfDay()", function () {
        it("Should return the next settlement timestamp", async function () {
            expect(await fund.endOfDay(startTimestamp)).to.equal(startDay);
            expect(await fund.endOfDay(startTimestamp + DAY * 10)).to.equal(startDay + DAY * 10);
        });

        it("Should return the next day if given a settlement timestamp", async function () {
            expect(await fund.endOfDay(startDay)).to.equal(startDay + DAY);
            expect(await fund.endOfDay(startDay + DAY * 10)).to.equal(startDay + DAY * 11);
        });
    });

    describe("isFundActive()", function () {
        it("Should revert transfer when inactive", async function () {
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(parseEther("500"), 0, parseBtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.isFundActive(startDay + HOUR * 12 - 1)).to.equal(false);
            await expect(
                fund.connect(shareM).transfer(TRANCHE_M, addr1, addr2, 0)
            ).to.be.revertedWith("Transfer is inactive");
        });

        it("Should return the activity window without rebalance", async function () {
            expect(await fund.fundActivityStartTime()).to.equal(startDay - DAY);
            expect(await fund.currentDay()).to.equal(startDay);
            expect(await fund.isFundActive(startDay - DAY + HOUR * 12)).to.equal(true);

            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(startDay);
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(await fund.isFundActive(startDay + HOUR * 12)).to.equal(true);
        });

        it("Should return the activity window with rebalance", async function () {
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(parseEther("500"), 0, parseBtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(
                startDay + POST_REBALANCE_DELAY_TIME
            );
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(await fund.isFundActive(startDay + POST_REBALANCE_DELAY_TIME - 1)).to.equal(
                false
            );
            expect(await fund.isFundActive(startDay + POST_REBALANCE_DELAY_TIME)).to.equal(true);
        });
    });

    describe("isPrimaryMarketActive()", function () {
        it("Should return inactive for non-primaryMarket contracts", async function () {
            expect(await fund.fundActivityStartTime()).to.equal(startDay - DAY);
            expect(await fund.currentDay()).to.equal(startDay);
            expect(await fund.isPrimaryMarketActive(addr1, startDay - DAY + HOUR * 12)).to.equal(
                false
            );
        });

        it("Should return the activity window without rebalance", async function () {
            expect(await fund.fundActivityStartTime()).to.equal(startDay - DAY);
            expect(await fund.currentDay()).to.equal(startDay);
            expect(
                await fund.isPrimaryMarketActive(primaryMarket.address, startDay - DAY + HOUR * 12)
            ).to.equal(true);

            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(startDay);
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(
                await fund.isPrimaryMarketActive(primaryMarket.address, startDay + HOUR * 12)
            ).to.equal(true);
        });

        it("Should return the activity window with rebalance", async function () {
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(parseEther("500"), 0, parseBtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(
                startDay + POST_REBALANCE_DELAY_TIME
            );
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(
                await fund.isPrimaryMarketActive(
                    primaryMarket.address,
                    startDay + POST_REBALANCE_DELAY_TIME - 1
                )
            ).to.equal(false);
            expect(
                await fund.isPrimaryMarketActive(
                    primaryMarket.address,
                    startDay + POST_REBALANCE_DELAY_TIME
                )
            ).to.equal(true);
        });
    });

    describe("isExchangeActive()", function () {
        it("Should return the activity window without rebalance", async function () {
            expect(await fund.exchangeActivityStartTime()).to.equal(startDay - DAY + HOUR / 2);
            expect(await fund.isExchangeActive(startDay - DAY + HOUR * 12 + HOUR / 2)).to.equal(
                true
            );

            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.exchangeActivityStartTime()).to.equal(startDay + HOUR / 2);
            expect(await fund.isExchangeActive(startDay + HOUR * 12 + HOUR / 2)).to.equal(true);
        });

        it("Should return the activity window with rebalance", async function () {
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(parseEther("500"), 0, parseBtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.exchangeActivityStartTime()).to.equal(
                startDay + POST_REBALANCE_DELAY_TIME
            );
            expect(await fund.isExchangeActive(startDay + POST_REBALANCE_DELAY_TIME - 1)).to.equal(
                false
            );
            expect(await fund.isExchangeActive(startDay + POST_REBALANCE_DELAY_TIME)).to.equal(
                true
            );
        });
    });

    describe("FundRoles", function () {
        describe("PrimaryMarket", function () {
            it("Should initialize the only PrimaryMarket address", async function () {
                expect(await fund.isPrimaryMarket(primaryMarket.address)).to.equal(true);
                expect(await fund.getPrimaryMarketCount()).to.equal(1);
            });

            it("Should be able to add PrimaryMarket", async function () {
                await fund.connect(owner).addNewPrimaryMarket(addr1);
                await fund.connect(owner).addNewPrimaryMarket(addr1);
                expect(await fund.isPrimaryMarket(primaryMarket.address)).to.equal(true);

                await twapOracle.mock.getTwap.returns(parseEther("1000"));
                await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
                await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
                await advanceBlockAtTime((await fund.currentDay()).toNumber());

                await expect(fund.settle()).to.emit(fund, "PrimaryMarketAdded").withArgs(addr1);

                expect(await fund.isPrimaryMarket(addr1)).to.equal(true);
                expect(await fund.getPrimaryMarketCount()).to.equal(2);
                await fund.connect(owner).addObsoletePrimaryMarket(primaryMarket.address);
            });

            it("Should be able to remove PrimaryMarket", async function () {
                await fund.connect(owner).addObsoletePrimaryMarket(primaryMarket.address);
                await fund.connect(owner).addObsoletePrimaryMarket(primaryMarket.address);
                expect(await fund.isPrimaryMarket(primaryMarket.address)).to.equal(true);

                await twapOracle.mock.getTwap.returns(parseEther("1000"));
                await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
                await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
                await advanceBlockAtTime((await fund.currentDay()).toNumber());

                await expect(fund.settle())
                    .to.emit(fund, "PrimaryMarketRemoved")
                    .withArgs(primaryMarket.address);

                expect(await fund.isPrimaryMarket(primaryMarket.address)).to.equal(false);
                expect(await fund.getPrimaryMarketCount()).to.equal(0);
            });

            it("Should reject if PrimaryMarket has already been added or removed", async function () {
                await expect(
                    fund.connect(owner).addNewPrimaryMarket(primaryMarket.address)
                ).to.be.revertedWith("The address is already a primary market");

                await expect(
                    fund.connect(owner).addObsoletePrimaryMarket(addr1)
                ).to.be.revertedWith("The address is not a primary market");
            });

            it("Should reject changing PrimaryMarket from non-admin address", async function () {
                await expect(fund.addNewPrimaryMarket(addr1)).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );

                await expect(fund.addObsoletePrimaryMarket(addr1)).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );
            });
        });

        describe("Share", function () {
            it("Should initialize the three Share addresses", async function () {
                expect(await fund.isShare(shareM.address)).to.equal(true);
                expect(await fund.isShare(shareA.address)).to.equal(true);
                expect(await fund.isShare(shareB.address)).to.equal(true);
            });
        });
    });

    describe("InterestRateBallot", function () {
        it("Should return the next settlement timestamp", async function () {
            expect(
                await fund.historicalInterestRate(await fund.endOfWeek(await fund.currentDay()))
            ).to.equal(parseEther("0"));
            await interestRateBallot.mock.count.returns(parseEther("365"));
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(0);
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();
            expect(
                await fund.historicalInterestRate(await fund.endOfWeek(await fund.currentDay()))
            ).to.equal(parseEther("1"));
        });
    });

    describe("Share balance management", function () {
        let outerFixture: Fixture<FixtureData>;

        let fundFromShares: { fundFromShare: Contract; tranche: number }[];

        async function fakePrimaryMarketFixture(): Promise<FixtureData> {
            const oldF = await loadFixture(deployFixture);
            const f = { ...oldF };
            // Initiating transactions from a Waffle mock contract doesn't work well
            // in Hardhat and may fail with gas estimating errors. We grant the role
            // to an EOA to make test development easier.
            await f.fund.connect(f.wallets.owner).addNewPrimaryMarket(f.wallets.user2.address);
            await f.twapOracle.mock.getTwap.returns(parseEther("1000"));
            await f.aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await f.primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceBlockAtTime((await fund.currentDay()).toNumber());
            await f.fund.settle();

            f.fund = f.fund.connect(f.wallets.user2);
            // Mint some shares to user2
            await f.fund.mint(TRANCHE_M, f.wallets.user2.address, 10000);
            await f.fund.mint(TRANCHE_A, f.wallets.user2.address, 10000);
            await f.fund.mint(TRANCHE_B, f.wallets.user2.address, 10000);
            return f;
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = fakePrimaryMarketFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        beforeEach(function () {
            fundFromShares = [
                { fundFromShare: fund.connect(shareM), tranche: TRANCHE_M },
                { fundFromShare: fund.connect(shareA), tranche: TRANCHE_A },
                { fundFromShare: fund.connect(shareB), tranche: TRANCHE_B },
            ];
        });

        describe("mint()", function () {
            it("Should revert if not called from PrimaryMarket", async function () {
                await expect(fund.connect(user1).mint(TRANCHE_M, addr1, 1)).to.be.revertedWith(
                    "FundRoles: only primary market"
                );
            });

            it("Should update balance and total supply", async function () {
                await fund.mint(TRANCHE_M, addr1, 123);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(123);
                await fund.mint(TRANCHE_M, addr1, 456);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(579);
                await fund.mint(TRANCHE_M, addr2, 1000);
                await fund.mint(TRANCHE_A, addr2, 10);
                await fund.mint(TRANCHE_B, addr2, 100);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr2)).to.equal(11000);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(10010);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(10100);
                expect(await fund.shareTotalSupply(TRANCHE_M)).to.equal(11579);
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(10010);
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(10100);
            });

            it("Should revert on minting to the zero address", async function () {
                await expect(
                    fund.mint(TRANCHE_M, ethers.constants.AddressZero, 100)
                ).to.be.revertedWith("ERC20: mint to the zero address");
            });

            it("Should revert on overflow", async function () {
                const HALF_MAX = BigNumber.from("2").pow(255);
                await fund.mint(TRANCHE_M, addr1, HALF_MAX);
                await expect(fund.mint(TRANCHE_M, addr1, HALF_MAX)).to.be.reverted;
                await expect(fund.mint(TRANCHE_M, addr2, HALF_MAX)).to.be.reverted;
            });
        });

        describe("burn()", function () {
            it("Should revert if not called from PrimaryMarket", async function () {
                await expect(fund.connect(user1).burn(TRANCHE_M, addr1, 1)).to.be.revertedWith(
                    "FundRoles: only primary market"
                );
            });

            it("Should update balance and total supply", async function () {
                await fund.mint(TRANCHE_M, addr1, 10000);
                await fund.burn(TRANCHE_M, addr1, 1000);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(9000);
                await fund.burn(TRANCHE_M, addr1, 2000);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(7000);
                await fund.burn(TRANCHE_M, addr2, 100);
                await fund.burn(TRANCHE_A, addr2, 10);
                await fund.burn(TRANCHE_B, addr2, 1);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr2)).to.equal(9900);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(9990);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(9999);
                expect(await fund.shareTotalSupply(TRANCHE_M)).to.equal(16900);
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(9990);
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(9999);
            });

            it("Should revert on burning from the zero address", async function () {
                await expect(
                    fund.burn(TRANCHE_M, ethers.constants.AddressZero, 100)
                ).to.be.revertedWith("ERC20: burn from the zero address");
            });

            it("Should revert if balance is not enough", async function () {
                await expect(fund.burn(TRANCHE_M, addr1, 1)).to.be.reverted;
                await fund.mint(TRANCHE_M, addr1, 100);
                await expect(fund.burn(TRANCHE_M, addr1, 101)).to.be.reverted;
            });
        });

        describe("transfer()", function () {
            it("Should revert if not called from Share", async function () {
                await expect(fund.transfer(TRANCHE_M, addr1, addr2, 1)).to.be.revertedWith(
                    "FundRoles: only share"
                );
            });

            it("Should reject transfer from the zero address", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    await expect(
                        fundFromShare.transfer(tranche, ethers.constants.AddressZero, addr1, 1)
                    ).to.be.revertedWith("ERC20: transfer from the zero address");
                }
            });

            it("Should reject transfer to the zero address", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    await expect(
                        fundFromShare.transfer(tranche, addr1, ethers.constants.AddressZero, 1)
                    ).to.be.revertedWith("ERC20: transfer to the zero address");
                }
            });

            it("Should update balance and keep total supply", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    await fundFromShare.transfer(tranche, addr2, addr1, 10000);
                    expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(10000);
                    expect(await fund.shareBalanceOf(TRANCHE_M, addr2)).to.equal(0);
                    expect(await fund.shareTotalSupply(TRANCHE_M)).to.equal(10000);
                }
            });

            it("Should revert if balance is not enough", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    await expect(
                        fundFromShare.transfer(tranche, addr2, addr1, 10001)
                    ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
                }
            });
        });

        describe("approve()", function () {
            it("Should revert if not called from Share", async function () {
                await expect(fund.approve(TRANCHE_M, addr1, addr2, 1)).to.be.revertedWith(
                    "FundRoles: only share"
                );
            });

            it("Should reject approval from the zero address", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    await expect(
                        fundFromShare.approve(tranche, ethers.constants.AddressZero, addr1, 1)
                    ).to.be.revertedWith("ERC20: approve from the zero address");
                }
            });

            it("Should reject approval to the zero address", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    await expect(
                        fundFromShare.approve(tranche, addr1, ethers.constants.AddressZero, 1)
                    ).to.be.revertedWith("ERC20: approve to the zero address");
                }
            });

            it("Should update allowance", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    expect(await fund.shareAllowance(tranche, addr1, addr2)).to.equal(0);
                    await fundFromShare.approve(tranche, addr1, addr2, 100);
                    expect(await fund.shareAllowance(tranche, addr1, addr2)).to.equal(100);
                    await fundFromShare.approve(tranche, addr1, addr2, 10);
                    expect(await fund.shareAllowance(tranche, addr1, addr2)).to.equal(10);
                }
            });
        });
    });

    describe("Reverted settlement", function () {
        it("Should revert before the current trading day ends", async function () {
            await expect(fund.settle()).to.be.revertedWith(
                "The current trading day does not end yet"
            );
            await advanceBlockAtTime(startDay - 30);
            await expect(fund.settle()).to.be.revertedWith(
                "The current trading day does not end yet"
            );
        });

        it("Should revert if underlying price is not ready", async function () {
            await twapOracle.mock.getTwap.returns(0);
            await advanceBlockAtTime(startDay);
            await expect(fund.settle()).to.be.revertedWith(
                "Underlying price for settlement is not ready yet"
            );
        });
    });

    describe("Settlement of an empty fund", function () {
        let outerFixture: Fixture<FixtureData>;

        let primaryMarketSettle: Stub;

        async function firstDayFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            await f.twapOracle.mock.getTwap.withArgs(f.startDay).returns(parseEther("1010"));
            await f.aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await advanceBlockAtTime(f.startDay);
            return f;
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = firstDayFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        beforeEach(function () {
            primaryMarketSettle = primaryMarket.mock.settle.withArgs(
                startDay,
                0,
                0,
                parseEther("1010"),
                parseEther("1")
            );
        });

        it("Should keep previous NAV when nothing happened", async function () {
            await primaryMarketSettle.returns(0, 0, 0, 0, 0);
            await expect(fund.settle())
                .to.emit(fund, "Settled")
                .withArgs(startDay, parseEther("1"), parseEther("1"), parseEther("1"));
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs[TRANCHE_M]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
        });

        it("Should transfer no fee to the fee collector", async function () {
            await primaryMarketSettle.returns(0, 0, 0, 0, 0);
            await fund.settle();
            expect(await btc.balanceOf(feeCollector.address)).to.equal(0);
        });

        it("Should mint created shares", async function () {
            // Create 1010 shares with 1 BTC
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarketSettle.returns(parseEther("1010"), 0, parseBtc("1"), 0, 0);
            await fund.settle();
            expect(await fund.shareBalanceOf(TRANCHE_M, primaryMarket.address)).to.equal(
                parseEther("1010")
            );
        });

        it("Should transfer creation fee to the fee collector", async function () {
            // Create 909 shares with 1 BTC (10% fee)
            await btc.mint(primaryMarket.address, parseBtc("1"));
            const fee = parseBtc("0.1");
            await primaryMarketSettle.returns(parseEther("909"), 0, parseBtc("1"), 0, fee);
            await fund.settle();
            expect(await btc.balanceOf(feeCollector.address)).to.equal(fee);
            expect(await btc.balanceOf(fund.address)).to.equal(parseBtc("1").sub(fee));
        });

        it("Should update NAV according to creation", async function () {
            // Received 1 BTC (1010 USD) and minted 1000 shares.
            // NAV of Token M increases to 1010 / 1000 = 1.01.
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarketSettle.returns(parseEther("1000"), 0, parseBtc("1"), 0, 0);
            await fund.settle();
            const navs = await fund.historicalNavs(startDay);
            expect(navs[TRANCHE_M]).to.equal(parseEther("1.01"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1.02"));
        });

        it("Should trigger upper rebalance on abnormal creation", async function () {
            // Received 1 BTC (1010 USD) and minted 500 shares.
            // NAV of Token M increases to 1010 / 500 = 2.02 and triggers rebalance.
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarketSettle.returns(parseEther("500"), 0, parseBtc("1"), 0, 0);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(1);
            const navs = await fund.historicalNavs(startDay);
            expect(navs[TRANCHE_M]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
            // Shares in the primary market is rebalanced on read
            expect(await fund.shareBalanceOf(TRANCHE_M, primaryMarket.address)).to.equal(
                parseEther("1010")
            );
        });
    });

    describe("Settlement of a non-empty fund", function () {
        let outerFixture: Fixture<FixtureData>;

        let protocolFee: BigNumber;
        let btcInFund: BigNumber;
        let navA: BigNumber;
        let primaryMarketSettle: Stub;

        async function secondDayFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            await f.aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day

            // Create 10000 shares with 10 BTC on the first day.
            await f.twapOracle.mock.getTwap.withArgs(f.startDay).returns(parseEther("1000"));
            await f.btc.mint(f.primaryMarket.address, parseBtc("10"));
            await f.primaryMarket.mock.settle.returns(parseEther("10000"), 0, parseBtc("10"), 0, 0);
            await advanceBlockAtTime(f.startDay);
            await f.fund.settle();
            await f.primaryMarket.mock.settle.revertsWithReason("Mock function is reset");

            // Total shares: 10000
            // BTC in the fund: 10
            // NAV of (M, A, B): (1, 1, 1)
            await f.twapOracle.mock.getTwap.withArgs(f.startDay + DAY).returns(parseEther("1000"));
            await advanceBlockAtTime(f.startDay + DAY);
            return f;
        }

        function primaryMarketSettleAtPrice(price: BigNumber): Stub {
            return primaryMarket.mock.settle.withArgs(
                startDay + DAY,
                parseEther("10000"),
                btcInFund,
                price,
                parseEther("1")
            );
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = secondDayFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        beforeEach(async function () {
            protocolFee = parseBtc("10").mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
            btcInFund = parseBtc("10").sub(protocolFee);
            navA = parseEther("1.001")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            primaryMarketSettle = primaryMarketSettleAtPrice(parseEther("1000"));
        });

        it("Should charge protocol fee and interest when nothing happened", async function () {
            await primaryMarketSettle.returns(0, 0, 0, 0, 0);
            const navM = btcInFund.mul(1e10).mul(1000).div(10000); // btc * price(1000) / share(10000)
            const navB = navM.mul(2).sub(navA);
            await expect(fund.settle())
                .to.emit(fund, "Settled")
                .withArgs(startDay + DAY, navM, navA, navB);
            expect(await fund.currentDay()).to.equal(startDay + DAY * 2);
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_M]).to.equal(navM);
            expect(navs[TRANCHE_A]).to.equal(navA);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });

        it("Should transfer protocol fee to the fee collector", async function () {
            await primaryMarketSettle.returns(0, 0, 0, 0, 0);
            await fund.settle();
            expect(await btc.balanceOf(feeCollector.address)).to.equal(protocolFee);
        });

        it("Should net shares and underlying (creation > redemption)", async function () {
            // Create 1000 shares with 1 BTC and redeem 400 shares for 0.4 BTC
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarketSettle.returns(
                parseEther("1000"),
                parseEther("400"),
                parseBtc("1"),
                parseBtc("0.4"),
                0
            );
            const oldM = await fund.shareBalanceOf(TRANCHE_M, primaryMarket.address);
            await expect(() => fund.settle()).to.changeTokenBalances(
                btc,
                [fund, primaryMarket],
                [parseBtc("0.6").sub(protocolFee), parseBtc("-0.6")]
            );
            expect(await fund.shareBalanceOf(TRANCHE_M, primaryMarket.address)).to.equal(
                oldM.add(parseEther("600"))
            );
        });

        it("Should net shares and underlying (creation < redemption)", async function () {
            // Create 1000 shares with 1 BTC and redeem 4000 shares for 4 BTC
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarketSettle.returns(
                parseEther("1000"),
                parseEther("4000"),
                parseBtc("1"),
                parseBtc("4"),
                0
            );
            const oldM = await fund.shareBalanceOf(TRANCHE_M, primaryMarket.address);
            await primaryMarket.mock.updateDelayedRedemptionDay.returns();
            await expect(() => fund.settle()).to.changeTokenBalances(
                btc,
                [fund, primaryMarket],
                [parseBtc("-3").sub(protocolFee), parseBtc("3")]
            );
            expect(await fund.shareBalanceOf(TRANCHE_M, primaryMarket.address)).to.equal(
                oldM.sub(parseEther("3000"))
            );
        });

        it("Should transfer all fee to the fee collector", async function () {
            // Create 900 shares with 1 BTC (10% fee)
            // Redeem 4000 shares for 3.6 BTC (10% fee)
            // There's also 50 shares (0.05 BTC) charged as split and merge fee.
            // Fee: 0.1 from creation, 0.4 from redemption, 0.05 from split and merge
            await btc.mint(primaryMarket.address, parseBtc("1"));
            const totalFee = parseBtc("0.55");
            await primaryMarketSettle.returns(
                parseEther("900"),
                parseEther("4050"),
                parseBtc("1"),
                parseBtc("3.6"),
                totalFee
            );
            await primaryMarket.mock.updateDelayedRedemptionDay.returns();
            await expect(() => fund.settle()).to.changeTokenBalances(
                btc,
                [fund, primaryMarket, feeCollector],
                [
                    parseBtc("-2.6").sub(totalFee).sub(protocolFee),
                    parseBtc("2.6"),
                    totalFee.add(protocolFee),
                ]
            );
        });

        it("Should update NAV according to primary market operations", async function () {
            // Create 9000 shares with 10 BTC (10% fee)
            // Redeem 4000 shares for 3.6 BTC (10% fee)
            // There's also 500 shares (0.5 BTC) charged as split and merge fee.
            // Fee: 1 from creation, 0.4 from redemption, 0.5 from split and merge
            await btc.mint(primaryMarket.address, parseBtc("10"));
            const totalFee = parseBtc("1.9");
            await primaryMarketSettle.returns(
                parseEther("9000"),
                parseEther("4500"),
                parseBtc("10"),
                parseBtc("3.6"),
                totalFee
            );
            const newBtcInFund = btcInFund.add(parseBtc("6.4")).sub(totalFee);
            const navM = newBtcInFund.mul(1e10).mul(1000).div(14500);
            const navB = navM.mul(2).sub(navA);
            // Note that NAV drops below 1 after protocol fee but creation and redemption are
            // still executed at NAV = 1 in this case. Because creation is more than redemption
            // and split/merge fee, the final navM is a bit higher than that if nothing happened.
            const navPLowerBound = btcInFund.mul(1e10).mul(1000).div(10000); // NAV of Token M if nothing happened
            expect(navM).to.be.gt(navPLowerBound);
            expect(navM).to.be.lt(parseEther("1"));

            await expect(fund.settle())
                .to.emit(fund, "Settled")
                .withArgs(startDay + DAY, navM, navA, navB);
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_M]).to.equal(navM);
            expect(navs[TRANCHE_A]).to.equal(navA);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });

        it("Should not trigger upper rebalance when price is not high enough", async function () {
            const price = parseEther("1500");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navM = btcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            const navB = navM.mul(2).sub(navA);
            const navBOverA = navB.mul(parseEther("1")).div(navA);
            expect(navBOverA).to.be.lt(UPPER_REBALANCE_THRESHOLD);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_M]).to.equal(navM);
        });

        it("Should trigger upper rebalance when price is high enough", async function () {
            const price = parseEther("1510");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navM = btcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            const navB = navM.mul(2).sub(navA);
            const navBOverA = navB.mul(parseEther("1")).div(navA);
            expect(navBOverA).to.be.gt(UPPER_REBALANCE_THRESHOLD);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(1);
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_M]).to.equal(parseEther("1"));
        });

        it("Should not trigger lower rebalance when price is not low enough", async function () {
            const price = parseEther("755");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navM = btcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            const navB = navM.mul(2).sub(navA);
            const navBOverA = navB.mul(parseEther("1")).div(navA);
            expect(navBOverA).to.be.gt(LOWER_REBALANCE_THRESHOLD);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });

        it("Should trigger lower rebalance when price is low enough", async function () {
            const price = parseEther("750");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navM = btcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            const navB = navM.mul(2).sub(navA);
            const navBOverA = navB.mul(parseEther("1")).div(navA);
            expect(navBOverA).to.be.lt(LOWER_REBALANCE_THRESHOLD);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(1);
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
        });
    });

    describe("extrapolateNav()", function () {
        it("Should return ones before any shares are created", async function () {
            const navs = await fund.extrapolateNav(startDay - DAY * 10, parseEther("8000"));
            expect(navs[TRANCHE_M]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
        });

        it("Should return the previous settlement if fund is empty", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseBtc("1"), 0, 0);
            await primaryMarket.mock.updateDelayedRedemptionDay.returns();
            await advanceOneDayAndSettle();

            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();
            // All shares redeemed on settlement
            const emptyDay = (await fund.currentDay()).toNumber();
            const redeemedBtc = (await btc.balanceOf(fund.address))
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            await primaryMarket.mock.settle.returns(0, parseEther("1000"), 0, redeemedBtc, 0);
            await advanceOneDayAndSettle();
            // Create the shares again
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, redeemedBtc, 0, 0);
            await advanceOneDayAndSettle();

            const expectedM = parseEther("1")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedA = parseEther("1.001")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedB = expectedM.mul(2).sub(expectedA);
            const startNavs = await fund.extrapolateNav(emptyDay, parseEther("8000"));
            expect(startNavs[TRANCHE_M]).to.equal(expectedM);
            expect(startNavs[TRANCHE_A]).to.equal(expectedA);
            expect(startNavs[TRANCHE_B]).to.equal(expectedB);
            const endNavs = await fund.extrapolateNav(emptyDay + DAY - 1, parseEther("8000"));
            expect(endNavs[TRANCHE_M]).to.equal(expectedM);
            expect(endNavs[TRANCHE_A]).to.equal(expectedA);
            expect(endNavs[TRANCHE_B]).to.equal(expectedB);
        });

        it("Should use the price", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseBtc("1"), 0, 0);
            await advanceOneDayAndSettle();
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

            const day = (await fund.currentDay()).toNumber();
            await advanceOneDayAndSettle();

            const expectedA = parseEther("1.001")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedP1000 = parseEther("1")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedB1000 = expectedP1000.mul(2).sub(expectedA);
            const navsAt1000 = await fund.extrapolateNav(day, parseEther("1000"));
            expect(navsAt1000[TRANCHE_M]).to.equal(expectedP1000);
            expect(navsAt1000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt1000[TRANCHE_B]).to.equal(expectedB1000);

            const expectedP2000 = parseEther("2")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedB2000 = expectedP2000.mul(2).sub(expectedA);
            const navsAt2000 = await fund.extrapolateNav(day, parseEther("2000"));
            expect(navsAt2000[TRANCHE_M]).to.equal(expectedP2000);
            expect(navsAt2000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt2000[TRANCHE_B]).to.equal(expectedB2000);
        });

        it("Should accrue protocol fee and interest", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseBtc("1"), 0, 0);
            await advanceOneDayAndSettle();
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

            const day = (await fund.currentDay()).toNumber();
            await advanceOneDayAndSettle();

            const navPAtDay = parseEther("1")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedM = navPAtDay.mul(20000 - DAILY_PROTOCOL_FEE_BPS).div(20000);
            const navAAtDay = parseEther("1.001")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedA = navAAtDay
                .mul(10005)
                .div(10000)
                .mul(20000 - DAILY_PROTOCOL_FEE_BPS)
                .div(20000);
            const expectedB = expectedM.mul(2).sub(expectedA);
            const navsAt1000 = await fund.extrapolateNav(day + DAY / 2, parseEther("1000"));
            expect(navsAt1000[TRANCHE_M]).to.equal(expectedM);
            expect(navsAt1000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt1000[TRANCHE_B]).to.equal(expectedB);
        });

        it("Should predict NAV in the future", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await btc.mint(primaryMarket.address, parseBtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseBtc("1"), 0, 0);
            await advanceOneDayAndSettle();
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

            const day = (await fund.currentDay()).toNumber();
            await advanceOneDayAndSettle();

            const navPAtDay = parseEther("1")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedM = navPAtDay.mul(10000 - DAILY_PROTOCOL_FEE_BPS * 10).div(10000);
            const navAAtDay = parseEther("1.001")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const expectedA = navAAtDay
                .mul(101)
                .div(100)
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS * 10)
                .div(10000);
            const expectedB = expectedM.mul(2).sub(expectedA);
            const navsAt1000 = await fund.extrapolateNav(day + DAY * 10, parseEther("1000"));
            expect(navsAt1000[TRANCHE_M]).to.equal(expectedM);
            expect(navsAt1000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt1000[TRANCHE_B]).to.equal(expectedB);
        });

        it("Should keep NAV of Token A non-decreasing", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            // Interest of Token A is smaller than protocol fee
            await aprOracle.mock.capture.returns(
                parseEther("0.0001").mul(DAILY_PROTOCOL_FEE_BPS).div(2)
            );
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();

            const day = (await fund.currentDay()).toNumber();
            await primaryMarket.call(fund, "mint", TRANCHE_M, addr1, parseEther("1000"));
            await btc.mint(fund.address, parseBtc("1"));
            await advanceOneDayAndSettle();

            expect(
                (await fund.extrapolateNav(day + DAY / 2, parseEther("1000")))[TRANCHE_A]
            ).to.equal(parseEther("1"));
            expect(
                (await fund.extrapolateNav(day + DAY * 10, parseEther("1000")))[TRANCHE_A]
            ).to.equal(parseEther("1"));
        });
    });

    async function zeroFeeFixture(): Promise<FixtureData> {
        const oldF = await loadFixture(deployFixture);
        const f = { ...oldF };
        await f.twapOracle.mock.getTwap.returns(parseEther("1000"));
        await f.aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
        await f.primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

        // Overwrite the fund with a new one with zero protocol fee
        const Fund = await ethers.getContractFactory("FundV2");
        f.fund = await Fund.connect(f.wallets.owner).deploy(
            f.btc.address,
            8,
            0, // Zero protocol fee
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            f.twapOracle.address,
            f.aprOracle.address,
            f.interestRateBallot.address,
            f.wallets.feeCollector.address
        );
        await f.fund.initialize(
            f.wallets.shareM.address,
            f.wallets.shareA.address,
            f.wallets.shareB.address,
            f.primaryMarket.address,
            ethers.constants.AddressZero
        );
        return f;
    }

    describe("Rebalance trigger conditions", function () {
        let outerFixture: Fixture<FixtureData>;

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = zeroFeeFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should not trigger at exactly upper rebalance threshold", async function () {
            await primaryMarket.call(fund, "mint", TRANCHE_M, addr1, parseEther("1000"));
            await btc.mint(fund.address, parseBtc("1.5"));
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs[TRANCHE_M]).to.equal(parseEther("1.5"));
        });

        it("Should not trigger at exactly lower rebalance threshold", async function () {
            await primaryMarket.call(fund, "mint", TRANCHE_M, addr1, parseEther("1000"));
            await btc.mint(fund.address, parseBtc("0.75"));
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs[TRANCHE_B]).to.equal(parseEther("0.5"));
        });

        it("Should not trigger at exactly fixed rebalance threshold", async function () {
            // Set daily interest rate to 10%
            await aprOracle.mock.capture.returns(parseEther("0.1"));
            await primaryMarket.call(fund, "mint", TRANCHE_M, addr1, parseEther("1000"));
            await btc.mint(fund.address, parseBtc("1"));
            await advanceOneDayAndSettle();

            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_A]).to.equal(parseEther("1.1"));
        });
    });

    describe("Rebalance", function () {
        let outerFixture: Fixture<FixtureData>;

        // Initial balances
        // User 1: 400 M + 100 A
        // User 2:         200 A + 300 B
        // Total:  400 M + 300 A + 300 B = 1000 total shares
        const INIT_P_1 = parseEther("400");
        const INIT_A_1 = parseEther("100");
        const INIT_B_1 = parseEther("0");
        const INIT_P_2 = parseEther("0");
        const INIT_A_2 = parseEther("200");
        const INIT_B_2 = parseEther("300");
        const INIT_BTC = parseBtc("1");

        async function rebalanceFixture(): Promise<FixtureData> {
            const f = await loadFixture(zeroFeeFixture);
            // Set daily interest rate to 10%
            await f.aprOracle.mock.capture.returns(parseEther("0.1"));
            await advanceBlockAtTime(f.startDay);
            await f.fund.settle();
            const addr1 = f.wallets.user1.address;
            const addr2 = f.wallets.user2.address;
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_M, addr1, INIT_P_1);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_A, addr1, INIT_A_1);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_B, addr1, INIT_B_1);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_M, addr2, INIT_P_2);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_A, addr2, INIT_A_2);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_B, addr2, INIT_B_2);
            await f.btc.mint(f.fund.address, INIT_BTC);
            await advanceBlockAtTime(f.startDay + DAY);
            await f.fund.settle();
            return f;
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = rebalanceFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        // Trigger a new rebalance at the given NAV of Token M
        async function mockRebalance(navM: BigNumber) {
            const lastPrice = await twapOracle.getTwap(0);
            const newPrice = lastPrice.mul(navM).div(parseEther("1"));
            await twapOracle.mock.getTwap.returns(newPrice);
            await advanceOneDayAndSettle();
        }

        // NAV before rebalance: (1.7, 1.1, 2.3)
        // 1 M => 1.7 M'
        // 1 A => 0.1 M' + 1 A'
        // 1 B => 1.3 M'        + 1 B'
        const preDefinedRebalance170 = () => mockRebalance(parseEther("1.7"));

        // NAV before rebalance: (2.0, 1.1, 2.9)
        // 1 M => 2.0 M'
        // 1 A => 0.1 M' + 1 A'
        // 1 B => 1.9 M'        + 1 B'
        const preDefinedRebalance200 = () => mockRebalance(parseEther("2"));

        // NAV before rebalance: (0.7, 1.1, 0.3)
        // 1 M => 0.7 M'
        // 1 A => 0.8 M' + 0.3 A'
        // 1 B =>                   0.3 B'
        const preDefinedRebalance070 = () => mockRebalance(parseEther("0.7"));

        // NAV before rebalance: (0.4, 1.1, -0.3)
        // 1 M => 0.4 M'
        // 1 A => 0.8 M'
        // 1 B => 0
        const preDefinedRebalance040 = () => mockRebalance(parseEther("0.4"));

        describe("Rebalance matrix", function () {
            it("Upper rebalance", async function () {
                await preDefinedRebalance170();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs((await fund.currentDay()) - DAY);
                expect(navs[TRANCHE_M]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioM).to.equal(parseEther("1.7"));
                expect(rebalance.ratioA2M).to.equal(parseEther("0.1"));
                expect(rebalance.ratioB2M).to.equal(parseEther("1.3"));
                expect(rebalance.ratioAB).to.equal(parseEther("1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(parseEther("690"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(parseEther("100"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr2)).to.equal(parseEther("410"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(parseEther("200"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("300"));
                expect(await fund.shareTotalSupply(TRANCHE_M)).to.equal(parseEther("1100"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(parseEther("300"));
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(parseEther("300"));
                expect(await fund.getTotalShares()).to.equal(parseEther("1700"));
            });

            it("Lower rebalance", async function () {
                await preDefinedRebalance070();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs((await fund.currentDay()) - DAY);
                expect(navs[TRANCHE_M]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioM).to.equal(parseEther("0.7"));
                expect(rebalance.ratioA2M).to.equal(parseEther("0.8"));
                expect(rebalance.ratioB2M).to.equal(0);
                expect(rebalance.ratioAB).to.equal(parseEther("0.3"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(parseEther("360"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(parseEther("30"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr2)).to.equal(parseEther("160"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(parseEther("60"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("90"));
                expect(await fund.shareTotalSupply(TRANCHE_M)).to.equal(parseEther("520"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(parseEther("90"));
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(parseEther("90"));
                expect(await fund.getTotalShares()).to.equal(parseEther("700"));
            });

            it("Lower rebalance with negative NAV of Token B", async function () {
                await preDefinedRebalance040();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs((await fund.currentDay()) - DAY);
                expect(navs[TRANCHE_M]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioM).to.equal(parseEther("0.4"));
                expect(rebalance.ratioA2M).to.equal(parseEther("0.8"));
                expect(rebalance.ratioB2M).to.equal(0);
                expect(rebalance.ratioAB).to.equal(0);
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(parseEther("240"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr2)).to.equal(parseEther("160"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(0);
                expect(await fund.shareTotalSupply(TRANCHE_M)).to.equal(parseEther("400"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(0);
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(0);
                expect(await fund.getTotalShares()).to.equal(parseEther("400"));
            });
        });

        describe("doRebalance()", function () {
            it("Should use rebalance at the specified index", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                await preDefinedRebalance170(); // This one is selected
                await preDefinedRebalance040();
                const [m, a, b] = await fund.doRebalance(100000, 1000, 10, 2);
                expect(m).to.equal(170113);
                expect(a).to.equal(1000);
                expect(b).to.equal(10);
            });

            it("Should round down the result", async function () {
                await preDefinedRebalance200();
                expect((await fund.doRebalance(1, 0, 0, 0))[0]).to.equal(2);
                expect((await fund.doRebalance(0, 1, 0, 0))[0]).to.equal(0);
                expect((await fund.doRebalance(0, 0, 1, 0))[0]).to.equal(1);
                // Precise value is 2.0 + 0.1 + 1.9 = 4.0
                expect((await fund.doRebalance(1, 1, 1, 0))[0]).to.equal(3);
            });
        });

        describe("batchRebalance()", function () {
            it("Should use rebalance at the specified index range", async function () {
                await preDefinedRebalance040();
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                await preDefinedRebalance170();
                const [m, a, b] = await fund.batchRebalance(1000, 1000, 1000, 1, 4);
                expect(m).to.equal(6540);
                expect(a).to.equal(300);
                expect(b).to.equal(300);
            });
        });

        describe("getRebalance()", function () {
            it("Should return the rebalance struct at the given index", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance040();
                await preDefinedRebalance170();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                await preDefinedRebalance200();
                const rebalance = await fund.getRebalance(2);
                expect(rebalance.ratioM).to.equal(parseEther("1.7"));
                expect(rebalance.ratioA2M).to.equal(parseEther("0.1"));
                expect(rebalance.ratioB2M).to.equal(parseEther("1.3"));
                expect(rebalance.ratioAB).to.equal(parseEther("1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
            });

            it("Should return zeros if the given index is out of bound", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance040();
                await preDefinedRebalance170();
                await preDefinedRebalance200();
                const rebalance = await fund.getRebalance(4);
                expect(rebalance.ratioM).to.equal(0);
                expect(rebalance.ratioA2M).to.equal(0);
                expect(rebalance.ratioB2M).to.equal(0);
                expect(rebalance.ratioAB).to.equal(0);
                expect(rebalance.timestamp).to.equal(0);
            });
        });

        describe("getRebalanceTimestamp()", function () {
            it("Should return the trading day of a given rebalance", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance040();
                await preDefinedRebalance170();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                await preDefinedRebalance200();
                expect(await fund.getRebalanceTimestamp(2)).to.equal(settlementTimestamp);
            });

            it("Should return zero if the given index is out of bound", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance040();
                await preDefinedRebalance170();
                await preDefinedRebalance200();
                expect(await fund.getRebalanceTimestamp(4)).to.equal(0);
            });
        });

        describe("Balance refresh on interaction", function () {
            it("No refresh when rebalance is triggered", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                expect(await fund.shareBalanceVersion(addr1)).to.equal(0);
                expect(await fund.shareBalanceVersion(addr2)).to.equal(0);
            });

            it("transfer()", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                const oldA1 = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB2 = await fund.shareBalanceOf(TRANCHE_B, addr2);
                await advanceOneDayAndSettle();
                await fund.connect(shareM).transfer(TRANCHE_M, addr1, addr2, 1);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(2);
                expect(await fund.shareBalanceVersion(addr2)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA1);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(oldB2);
            });

            it("mint()", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                await primaryMarket.call(fund, "mint", TRANCHE_M, addr1, 1);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
            });

            it("burn()", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr2);
                await primaryMarket.call(fund, "burn", TRANCHE_A, addr2, 1);
                expect(await fund.shareBalanceVersion(addr2)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(oldB);
            });
        });

        describe("refreshBalance()", function () {
            it("Non-zero targetVersion", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                await preDefinedRebalance170();
                await preDefinedRebalance040();
                await preDefinedRebalance070();
                const oldM = await fund.shareBalanceOf(TRANCHE_M, addr1);
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr1);
                await fund.refreshBalance(addr1, 2);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(oldM);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
                await fund.refreshBalance(addr1, 5);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(5);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(oldM);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
            });

            it("Zero targetVersion", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                await preDefinedRebalance170();
                const oldM = await fund.shareBalanceOf(TRANCHE_M, addr1);
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr1);
                await fund.refreshBalance(addr1, 0);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(3);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(oldM);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
            });

            it("Should make no change if targetVersion is older", async function () {
                await preDefinedRebalance070();
                await preDefinedRebalance200();
                await preDefinedRebalance170();
                const oldM = await fund.shareBalanceOf(TRANCHE_M, addr1);
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr1);
                await fund.refreshBalance(addr1, 3);
                await fund.refreshBalance(addr1, 1);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(3);
                expect(await fund.shareBalanceOf(TRANCHE_M, addr1)).to.equal(oldM);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
            });
        });
    });

    describe("Strategy update", function () {
        it("Should revert if not proposed by owner", async function () {
            await expect(fund.proposeStrategyUpdate(strategy.address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should revert if the original strategy is proposed", async function () {
            await expect(fund.connect(owner).proposeStrategyUpdate(await fund.strategy())).to.be
                .reverted;
        });

        it("Should update proposed change", async function () {
            await fund.connect(owner).proposeStrategyUpdate(strategy.address);
            expect(await fund.proposedStrategy()).to.equal(strategy.address);
        });

        it("Should emit event on proposal", async function () {
            const t = startTimestamp + HOUR;
            await setNextBlockTime(t);
            await expect(fund.connect(owner).proposeStrategyUpdate(strategy.address))
                .to.emit(fund, "StrategyUpdateProposed")
                .withArgs(
                    strategy.address,
                    t + STRATEGY_UPDATE_MIN_DELAY,
                    t + STRATEGY_UPDATE_MAX_DELAY
                );
        });

        it("Should revert if not applied by owner", async function () {
            await expect(fund.applyStrategyUpdate(strategy.address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should revert if apply a different strategy change", async function () {
            await fund.connect(owner).proposeStrategyUpdate(strategy.address);
            await expect(fund.connect(owner).applyStrategyUpdate(user1.address)).to.be.revertedWith(
                "Proposed strategy mismatch"
            );
        });

        it("Should revert if apply too early or too late", async function () {
            const t = startTimestamp + HOUR;
            await setNextBlockTime(t);
            await fund.connect(owner).proposeStrategyUpdate(strategy.address);

            await advanceBlockAtTime(t + STRATEGY_UPDATE_MIN_DELAY - 10);
            await expect(
                fund.connect(owner).applyStrategyUpdate(strategy.address)
            ).to.be.revertedWith("Not ready to update strategy");
            await advanceBlockAtTime(t + STRATEGY_UPDATE_MAX_DELAY + 10);
            await expect(
                fund.connect(owner).applyStrategyUpdate(strategy.address)
            ).to.be.revertedWith("Not ready to update strategy");
        });

        it("Should update strategy", async function () {
            const t = startTimestamp + HOUR;
            await setNextBlockTime(t);
            await fund.connect(owner).proposeStrategyUpdate(strategy.address);
            await advanceBlockAtTime(t + STRATEGY_UPDATE_MIN_DELAY + 10);
            await fund.connect(owner).applyStrategyUpdate(strategy.address);
            expect(await fund.strategy()).to.equal(strategy.address);
            expect(await fund.proposedStrategy()).to.equal(ethers.constants.AddressZero);
            // Expect that the proposed timestamp is also reset.
            await expect(
                fund.connect(owner).applyStrategyUpdate(ethers.constants.AddressZero)
            ).to.be.revertedWith("Not ready to update strategy");
            await advanceBlockAtTime(t + STRATEGY_UPDATE_MIN_DELAY * 2 + 20);
            await expect(
                fund.connect(owner).applyStrategyUpdate(ethers.constants.AddressZero)
            ).to.be.revertedWith("Not ready to update strategy");
        });
    });

    describe("Settlement with strategy", function () {
        const navA = parseEther("1.001")
            .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
            .div(10000);

        beforeEach(async function () {
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await primaryMarket.mock.updateDelayedRedemptionDay.returns();
            // Change strategy
            await fund.connect(owner).proposeStrategyUpdate(strategy.address);
            await advanceBlockAtTime(startTimestamp + HOUR + STRATEGY_UPDATE_MIN_DELAY + 10);
            await fund.connect(owner).applyStrategyUpdate(strategy.address);
            await btc.connect(strategy).approve(fund.address, BigNumber.from("2").pow(256).sub(1));
            // Settle days before the strategy change
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            for (let i = 0; i < STRATEGY_UPDATE_MIN_DELAY / DAY; i++) {
                await fund.settle();
            }
            startDay += STRATEGY_UPDATE_MIN_DELAY;
            // Create 10000 shares with 10 BTC on the first day.
            await btc.mint(primaryMarket.address, parseBtc("10"));
            await primaryMarket.mock.settle.returns(parseEther("10000"), 0, parseBtc("10"), 0, 0);
            await advanceBlockAtTime(startDay);
            await fund.settle();
            await primaryMarket.mock.settle.revertsWithReason("Mock function is reset");
            // Transfer 9 BTC to the strategy
            await fund.connect(strategy).transferToStrategy(parseBtc("9"));
        });

        it("transferToStrategy()", async function () {
            expect(await fund.getStrategyUnderlying()).to.equal(parseBtc("9"));
            expect(await fund.getTotalUnderlying()).to.equal(parseBtc("10"));
            await expect(fund.transferToStrategy(parseBtc("1"))).to.be.revertedWith(
                "Only strategy"
            );
            await expect(() =>
                fund.connect(strategy).transferToStrategy(parseBtc("1"))
            ).to.changeTokenBalances(btc, [strategy, fund], [parseBtc("1"), parseBtc("-1")]);
            expect(await fund.getStrategyUnderlying()).to.equal(parseBtc("10"));
            expect(await fund.getTotalUnderlying()).to.equal(parseBtc("10"));
        });

        it("transferFromStrategy()", async function () {
            await expect(fund.transferFromStrategy(parseBtc("1"))).to.be.revertedWith(
                "Only strategy"
            );
            await expect(() =>
                fund.connect(strategy).transferFromStrategy(parseBtc("1"))
            ).to.changeTokenBalances(btc, [strategy, fund], [parseBtc("-1"), parseBtc("1")]);
            expect(await fund.getStrategyUnderlying()).to.equal(parseBtc("8"));
            expect(await fund.getTotalUnderlying()).to.equal(parseBtc("10"));
        });

        it("reportProfit", async function () {
            await expect(fund.reportProfit(parseBtc("1"), parseBtc("0.1"))).to.be.revertedWith(
                "Only strategy"
            );
            await expect(
                fund.connect(strategy).reportProfit(parseBtc("1"), parseBtc("2"))
            ).to.be.revertedWith("Performance fee cannot exceed profit");
            await expect(fund.connect(strategy).reportProfit(parseBtc("1"), parseBtc("0.1")))
                .to.emit(fund, "ProfitReported")
                .withArgs(parseBtc("1"), parseBtc("0.1"));
            expect(await fund.getStrategyUnderlying()).to.equal(parseBtc("10"));
            expect(await fund.getTotalUnderlying()).to.equal(parseBtc("10.9"));
            expect(await fund.feeDebt()).to.equal(parseBtc("0.1"));
            expect(await fund.getTotalDebt()).to.equal(parseBtc("0.1"));
        });

        it("reportLoss", async function () {
            await expect(fund.reportLoss(parseBtc("1"))).to.be.revertedWith("Only strategy");
            await expect(fund.connect(strategy).reportLoss(parseBtc("1")))
                .to.emit(fund, "LossReported")
                .withArgs(parseBtc("1"));
            expect(await fund.getStrategyUnderlying()).to.equal(parseBtc("8"));
            expect(await fund.getTotalUnderlying()).to.equal(parseBtc("9"));
            expect(await fund.getTotalDebt()).to.equal(0);
        });

        it("Should add fee into debt", async function () {
            await fund.connect(strategy).transferToStrategy(parseBtc("1"));
            await advanceBlockAtTime(startDay + DAY);
            await primaryMarket.mock.settle.returns(0, parseEther("100"), 0, 0, parseBtc("0.1"));
            await expect(() => fund.settle()).to.changeTokenBalance(btc, fund, 0);
            const fee = parseBtc("10").mul(DAILY_PROTOCOL_FEE_BPS).div(10000).add(parseBtc("0.1"));
            expect(await fund.feeDebt()).to.equal(fee);
            expect(await fund.getTotalDebt()).to.equal(fee);
        });

        it("Should add net redemption into debt", async function () {
            await advanceBlockAtTime(startDay + DAY);
            await primaryMarket.mock.settle.returns(
                parseEther("5000"),
                parseEther("8000"),
                parseBtc("5"),
                parseBtc("8"),
                0
            );
            const fee = parseBtc("10").mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
            await expect(() => fund.settle()).to.changeTokenBalances(
                btc,
                [fund, feeCollector, primaryMarket],
                [parseBtc("-1"), fee, parseBtc("1").sub(fee)]
            );
            const debt = parseBtc("2").add(fee);
            expect(await fund.redemptionDebts(primaryMarket.address)).to.equal(debt);
            expect(await fund.getTotalDebt()).to.equal(debt);
        });

        it("Should cumulate redemption debt", async function () {
            await advanceBlockAtTime(startDay + DAY * 2);
            await primaryMarket.mock.settle.returns(0, parseEther("3000"), 0, parseBtc("3"), 0);
            await fund.settle();
            const feeDay1 = parseBtc("10").mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
            const debtDay1 = parseBtc("2").add(feeDay1);

            await primaryMarket.mock.settle.returns(0, parseEther("4000"), 0, parseBtc("4"), 0);
            await fund.settle();
            const feeDay2 = parseBtc("7").sub(feeDay1).mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
            const debt = debtDay1.add(parseBtc("4"));
            expect(await fund.redemptionDebts(primaryMarket.address)).to.equal(debt);
            expect(await fund.getTotalDebt()).to.equal(debt.add(feeDay2));
        });

        it("Should net creation, redemption and debt", async function () {
            await advanceBlockAtTime(startDay + DAY * 2);
            await primaryMarket.mock.settle.returns(0, parseEther("3000"), 0, parseBtc("3"), 0);
            await fund.settle();
            const feeDay1 = parseBtc("10").mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
            const debtDay1 = parseBtc("2").add(feeDay1);

            await btc.mint(primaryMarket.address, parseBtc("4"));
            await primaryMarket.mock.settle.returns(
                parseEther("5000"),
                parseEther("1000"),
                parseBtc("5"),
                parseBtc("1"),
                0
            );
            const feeDay2 = parseBtc("7").sub(feeDay1).mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
            const net = parseBtc("4").sub(debtDay1);
            await expect(() => fund.settle()).to.changeTokenBalances(
                btc,
                [fund, feeCollector, primaryMarket],
                [net.sub(feeDay2), feeDay2, net.mul(-1)]
            );
            expect(await fund.redemptionDebts(primaryMarket.address)).to.equal(0);
            expect(await fund.getTotalDebt()).to.equal(0);
        });

        it("Should pay debt on transfer from strategy", async function () {
            await advanceBlockAtTime(startDay + DAY * 2);
            await primaryMarket.mock.settle.returns(0, parseEther("3000"), 0, parseBtc("3"), 0);
            await fund.settle();
            const fee = parseBtc("10").mul(DAILY_PROTOCOL_FEE_BPS).div(10000);

            await fund.connect(strategy).transferFromStrategy(fee.add(parseBtc("0.5")));
            expect(await fund.feeDebt()).to.equal(0);
            expect(await fund.redemptionDebts(primaryMarket.address)).to.equal(parseBtc("1.5"));
            expect(await fund.getTotalDebt()).to.equal(parseBtc("1.5"));
            await fund.connect(strategy).transferFromStrategy(parseBtc("2"));
            expect(await fund.redemptionDebts(primaryMarket.address)).to.equal(0);
            expect(await fund.getTotalDebt()).to.equal(0);
        });

        it("Should reject strategy change with debt", async function () {
            await fund.connect(strategy).transferToStrategy(parseBtc("1"));
            await advanceBlockAtTime(startDay + DAY);
            await primaryMarket.mock.settle.returns(0, parseEther("100"), 0, 0, parseBtc("0.1"));
            await fund.settle();
            await fund.connect(owner).proposeStrategyUpdate(addr1);
            await advanceBlockAtTime(startDay + DAY + STRATEGY_UPDATE_MIN_DELAY + DAY / 2);
            await expect(fund.connect(owner).applyStrategyUpdate(addr1)).to.be.revertedWith(
                "Cannot update strategy with debt"
            );
        });

        it("Should update NAV according to profit", async function () {
            // Profit is 5% of the total underlying at the last settlement
            await fund.connect(strategy).reportProfit(parseBtc("1"), parseBtc("0.5"));
            await advanceBlockAtTime(startDay + DAY);
            const navM = parseEther("1.05")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navB = navM.mul(2).sub(navA);
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await fund.settle();
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_M]).to.equal(navM);
            expect(navs[TRANCHE_A]).to.equal(navA);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });

        it("Should update NAV according to loss", async function () {
            // Loss is 10% of the total underlying at the last settlement
            await fund.connect(strategy).reportLoss(parseBtc("1"));
            await advanceBlockAtTime(startDay + DAY);
            const navM = parseEther("0.9")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navB = navM.mul(2).sub(navA);
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await fund.settle();
            const navs = await fund.historicalNavs(startDay + DAY);
            expect(navs[TRANCHE_M]).to.equal(navM);
            expect(navs[TRANCHE_A]).to.equal(navA);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });
    });
});
