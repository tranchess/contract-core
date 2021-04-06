import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider, Stub } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseWbtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";

const TRANCHE_P = 0;
const TRANCHE_A = 1;
const TRANCHE_B = 2;
const DAY = 86400;
const HOUR = 3600;
const SETTLEMENT_TIME = 3600 * 14; // UTC time 14:00 every day
const POST_CONVERSION_DELAY_TIME = HOUR * 12;
const DAILY_MANAGEMENT_FEE_BPS = 1; // 0.01% per day, 3.65% per year
const UPPER_CONVERSION_THRESHOLD = parseEther("1.5");
const LOWER_CONVERSION_THRESHOLD = parseEther("0.5");
const FIXED_CONVERSION_THRESHOLD = parseEther("1.1");

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

describe("Fund", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startDay: number;
        readonly startTimestamp: number;
        readonly twapOracle: MockContract;
        readonly wbtc: Contract;
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
    let shareP: Wallet;
    let shareA: Wallet;
    let shareB: Wallet;
    let governance: Wallet;
    let addr1: string;
    let addr2: string;
    let twapOracle: MockContract;
    let wbtc: Contract;
    let aprOracle: MockContract;
    let interestRateBallot: MockContract;
    let primaryMarket: MockContract;
    let fund: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        // Initiating transactions from a Waffle mock contract doesn't work well in Hardhat
        // and may fail with gas estimating errors. We use EOAs for the shares to make
        // test development easier.
        const [user1, user2, owner, shareP, shareA, shareB, governance] = provider.getWallets();

        // Start at 12 hours after settlement time of the 6th day in a week, which makes sure that
        // the first settlement after the fund's deployment settles the last day in a week and
        // starts a new week by updating interest rate of Share A. Many test cases in this file
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
        const wbtc = await MockToken.connect(owner).deploy("Wrapped BTC", "WBTC", 8);

        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day

        const interestRateBallot = await deployMockForName(owner, "IBallot");
        await interestRateBallot.mock.count.returns(0);

        const primaryMarket = await deployMockForName(owner, "IPrimaryMarket");

        const Fund = await ethers.getContractFactory("Fund");
        const fund = await Fund.connect(owner).deploy(
            parseEther("0.0001").mul(DAILY_MANAGEMENT_FEE_BPS),
            UPPER_CONVERSION_THRESHOLD,
            LOWER_CONVERSION_THRESHOLD,
            FIXED_CONVERSION_THRESHOLD,
            twapOracle.address
        );
        await primaryMarket.call(
            wbtc,
            "approve",
            fund.address,
            BigNumber.from("2").pow(256).sub(1)
        );

        await fund.initialize(
            wbtc.address,
            8,
            shareP.address,
            shareA.address,
            shareB.address,
            aprOracle.address,
            interestRateBallot.address,
            primaryMarket.address,
            governance.address
        );

        return {
            wallets: { user1, user2, owner, shareP, shareA, shareB, governance },
            startDay,
            startTimestamp,
            twapOracle,
            wbtc,
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
        shareP = fixtureData.wallets.shareP;
        shareA = fixtureData.wallets.shareA;
        shareB = fixtureData.wallets.shareB;
        governance = fixtureData.wallets.governance;
        addr1 = user1.address;
        addr2 = user2.address;
        startDay = fixtureData.startDay;
        startTimestamp = fixtureData.startTimestamp;
        twapOracle = fixtureData.twapOracle;
        wbtc = fixtureData.wbtc;
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
            expect(await fund.isFundActive(startDay - DAY + HOUR * 12)).to.equal(
                true
            );
            await fund.connect(shareP).transfer(TRANCHE_P, addr1, addr2, 0);

            const nextDay = (await fund.currentDay()).toNumber() + 1;
            await advanceBlockAtTime(nextDay);

            expect(await fund.isFundActive(nextDay)).to.equal(
                false
            );
            await expect(
                fund.connect(shareP).transfer(TRANCHE_P, addr1, addr2, 0)
            ).to.be.revertedWith("Transfer is inactive");
        });

        it("Should return the activity window without conversion", async function () {
            expect(await fund.fundActivityStartTime()).to.equal(startDay - DAY);
            expect(await fund.currentDay()).to.equal(startDay);
            expect(
                await fund.isFundActive(startDay - DAY + HOUR * 12)
            ).to.equal(true);

            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(startDay);
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(
                await fund.isFundActive(startDay + HOUR * 12)
            ).to.equal(true);
        });

        it("Should return the activity window with conversion", async function () {
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(parseEther("500"), 0, parseWbtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(
                startDay + POST_CONVERSION_DELAY_TIME
            );
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(
                await fund.isFundActive(
                    startDay + POST_CONVERSION_DELAY_TIME - 1
                )
            ).to.equal(false);
            expect(
                await fund.isFundActive(
                    startDay + POST_CONVERSION_DELAY_TIME
                )
            ).to.equal(true);
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

        it("Should return the activity window without conversion", async function () {
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

        it("Should return the activity window with conversion", async function () {
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(parseEther("500"), 0, parseWbtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(
                startDay + POST_CONVERSION_DELAY_TIME
            );
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(
                await fund.isPrimaryMarketActive(
                    primaryMarket.address,
                    startDay + POST_CONVERSION_DELAY_TIME - 1
                )
            ).to.equal(false);
            expect(
                await fund.isPrimaryMarketActive(
                    primaryMarket.address,
                    startDay + POST_CONVERSION_DELAY_TIME
                )
            ).to.equal(true);
        });
    });

    describe("isExchangeActive()", function () {
        it("Should return the activity window without conversion", async function () {
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

        it("Should return the activity window with conversion", async function () {
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await primaryMarket.mock.settle.returns(parseEther("500"), 0, parseWbtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            expect(await fund.exchangeActivityStartTime()).to.equal(
                startDay + POST_CONVERSION_DELAY_TIME
            );
            expect(await fund.isExchangeActive(startDay + POST_CONVERSION_DELAY_TIME - 1)).to.equal(
                false
            );
            expect(await fund.isExchangeActive(startDay + POST_CONVERSION_DELAY_TIME)).to.equal(
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
                expect(await fund.isShare(shareP.address)).to.equal(true);
                expect(await fund.isShare(shareA.address)).to.equal(true);
                expect(await fund.isShare(shareB.address)).to.equal(true);
            });
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
            await f.fund.mint(TRANCHE_P, f.wallets.user2.address, 10000);
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
                { fundFromShare: fund.connect(shareP), tranche: TRANCHE_P },
                { fundFromShare: fund.connect(shareA), tranche: TRANCHE_A },
                { fundFromShare: fund.connect(shareB), tranche: TRANCHE_B },
            ];
        });

        describe("mint()", function () {
            it("Should revert if not called from PrimaryMarket", async function () {
                await expect(fund.connect(user1).mint(TRANCHE_P, addr1, 1)).to.be.revertedWith(
                    "Only primary market"
                );
            });

            it("Should update balance and total supply", async function () {
                await fund.mint(TRANCHE_P, addr1, 123);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(123);
                await fund.mint(TRANCHE_P, addr1, 456);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(579);
                await fund.mint(TRANCHE_P, addr2, 1000);
                await fund.mint(TRANCHE_A, addr2, 10);
                await fund.mint(TRANCHE_B, addr2, 100);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(11000);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(10010);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(10100);
                expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(11579);
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(10010);
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(10100);
            });

            it("Should revert on minting to the zero address", async function () {
                await expect(
                    fund.mint(TRANCHE_P, ethers.constants.AddressZero, 100)
                ).to.be.revertedWith("ERC20: mint to the zero address");
            });

            it("Should revert on overflow", async function () {
                const HALF_MAX = BigNumber.from("2").pow(255);
                await fund.mint(TRANCHE_P, addr1, HALF_MAX);
                await expect(fund.mint(TRANCHE_P, addr1, HALF_MAX)).to.be.reverted;
                await expect(fund.mint(TRANCHE_P, addr2, HALF_MAX)).to.be.reverted;
            });
        });

        describe("burn()", function () {
            it("Should revert if not called from PrimaryMarket", async function () {
                await expect(fund.connect(user1).burn(TRANCHE_P, addr1, 1)).to.be.revertedWith(
                    "Only primary market"
                );
            });

            it("Should update balance and total supply", async function () {
                await fund.mint(TRANCHE_P, addr1, 10000);
                await fund.burn(TRANCHE_P, addr1, 1000);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(9000);
                await fund.burn(TRANCHE_P, addr1, 2000);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(7000);
                await fund.burn(TRANCHE_P, addr2, 100);
                await fund.burn(TRANCHE_A, addr2, 10);
                await fund.burn(TRANCHE_B, addr2, 1);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(9900);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(9990);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(9999);
                expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(16900);
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(9990);
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(9999);
            });

            it("Should revert on burning from the zero address", async function () {
                await expect(
                    fund.burn(TRANCHE_P, ethers.constants.AddressZero, 100)
                ).to.be.revertedWith("ERC20: burn from the zero address");
            });

            it("Should revert if balance is not enough", async function () {
                await expect(fund.burn(TRANCHE_P, addr1, 1)).to.be.reverted;
                await fund.mint(TRANCHE_P, addr1, 100);
                await expect(fund.burn(TRANCHE_P, addr1, 101)).to.be.reverted;
            });
        });

        describe("transfer()", function () {
            it("Should revert if not called from Share", async function () {
                await expect(fund.transfer(TRANCHE_P, addr1, addr2, 1)).to.be.revertedWith(
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
                    expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(10000);
                    expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(0);
                    expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(10000);
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
                await expect(fund.approve(TRANCHE_P, addr1, addr2, 1)).to.be.revertedWith(
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
            expect(await fund.getConversionSize()).to.equal(0);
            const navs = await fund.historyNavs(startDay);
            expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
        });

        it("Should transfer no fee to governance", async function () {
            await primaryMarketSettle.returns(0, 0, 0, 0, 0);
            await fund.settle();
            expect(await wbtc.balanceOf(governance.address)).to.equal(0);
        });

        it("Should mint created shares", async function () {
            // Create 1010 shares with 1 WBTC
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarketSettle.returns(parseEther("1010"), 0, parseWbtc("1"), 0, 0);
            await fund.settle();
            expect(await fund.shareBalanceOf(TRANCHE_P, primaryMarket.address)).to.equal(
                parseEther("1010")
            );
        });

        it("Should transfer creation fee to governance", async function () {
            // Create 909 shares with 1 WBTC (10% fee)
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            const fee = parseWbtc("0.1");
            await primaryMarketSettle.returns(parseEther("909"), 0, parseWbtc("1"), 0, fee);
            await fund.settle();
            expect(await wbtc.balanceOf(governance.address)).to.equal(fee);
            expect(await wbtc.balanceOf(fund.address)).to.equal(parseWbtc("1").sub(fee));
        });

        it("Should update NAV according to creation", async function () {
            // Received 1 WBTC (1010 USD) and minted 1000 shares.
            // NAV of Share P increases to 1010 / 1000 = 1.01.
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarketSettle.returns(parseEther("1000"), 0, parseWbtc("1"), 0, 0);
            await fund.settle();
            const navs = await fund.historyNavs(startDay);
            expect(navs[TRANCHE_P]).to.equal(parseEther("1.01"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1.02"));
        });

        it("Should trigger upper conversion on abnormal creation", async function () {
            // Received 1 WBTC (1010 USD) and minted 500 shares.
            // NAV of Share P increases to 1010 / 500 = 2.02 and triggers conversion.
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarketSettle.returns(parseEther("500"), 0, parseWbtc("1"), 0, 0);
            await fund.settle();
            expect(await fund.getConversionSize()).to.equal(1);
            const navs = await fund.historyNavs(startDay);
            expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
            // Shares in the primary market is converted on read
            expect(await fund.shareBalanceOf(TRANCHE_P, primaryMarket.address)).to.equal(
                parseEther("1010")
            );
        });
    });

    describe("Settlement of a non-empty fund", function () {
        let outerFixture: Fixture<FixtureData>;

        let managementFee: BigNumber;
        let wbtcInFund: BigNumber;
        let navA: BigNumber;
        let primaryMarketSettle: Stub;

        async function secondDayFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            await f.aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day

            // Create 10000 shares with 10 WBTC on the first day.
            await f.twapOracle.mock.getTwap.withArgs(f.startDay).returns(parseEther("1000"));
            await f.wbtc.mint(f.primaryMarket.address, parseWbtc("10"));
            await f.primaryMarket.mock.settle.returns(
                parseEther("10000"),
                0,
                parseWbtc("10"),
                0,
                0
            );
            await advanceBlockAtTime(f.startDay);
            await f.fund.settle();
            await f.primaryMarket.mock.settle.revertsWithReason("Mock function is reset");

            // Total shares: 10000
            // WBTC in the fund: 10
            // NAV of (P, A, B): (1, 1, 1)
            await f.twapOracle.mock.getTwap.withArgs(f.startDay + DAY).returns(parseEther("1000"));
            await advanceBlockAtTime(f.startDay + DAY);
            return f;
        }

        function primaryMarketSettleAtPrice(price: BigNumber): Stub {
            return primaryMarket.mock.settle.withArgs(
                startDay + DAY,
                parseEther("10000"),
                wbtcInFund,
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
            managementFee = parseWbtc("10").mul(DAILY_MANAGEMENT_FEE_BPS).div(10000);
            wbtcInFund = parseWbtc("10").sub(managementFee);
            navA = parseEther("1.001")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            primaryMarketSettle = primaryMarketSettleAtPrice(parseEther("1000"));
        });

        it("Should charge management fee and interest when nothing happened", async function () {
            await primaryMarketSettle.returns(0, 0, 0, 0, 0);
            const navP = wbtcInFund.mul(1e10).mul(1000).div(10000); // wbtc * price(1000) / share(10000)
            const navB = navP.mul(2).sub(navA);
            await expect(fund.settle())
                .to.emit(fund, "Settled")
                .withArgs(startDay + DAY, navP, navA, navB);
            expect(await fund.currentDay()).to.equal(startDay + DAY * 2);
            expect(await fund.getConversionSize()).to.equal(0);
            const navs = await fund.historyNavs(startDay + DAY);
            expect(navs[TRANCHE_P]).to.equal(navP);
            expect(navs[TRANCHE_A]).to.equal(navA);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });

        it("Should transfer management fee to governance", async function () {
            await primaryMarketSettle.returns(0, 0, 0, 0, 0);
            await fund.settle();
            expect(await wbtc.balanceOf(governance.address)).to.equal(managementFee);
        });

        it("Should net shares and underlying (creation > redemption)", async function () {
            // Create 1000 shares with 1 WBTC and redeem 400 shares for 0.4 WBTC
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarketSettle.returns(
                parseEther("1000"),
                parseEther("400"),
                parseWbtc("1"),
                parseWbtc("0.4"),
                0
            );
            const oldP = await fund.shareBalanceOf(TRANCHE_P, primaryMarket.address);
            await expect(() => fund.settle()).to.changeTokenBalances(
                wbtc,
                [fund, primaryMarket],
                [parseWbtc("0.6").sub(managementFee), parseWbtc("-0.6")]
            );
            expect(await fund.shareBalanceOf(TRANCHE_P, primaryMarket.address)).to.equal(
                oldP.add(parseEther("600"))
            );
        });

        it("Should net shares and underlying (creation < redemption)", async function () {
            // Create 1000 shares with 1 WBTC and redeem 4000 shares for 4 WBTC
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarketSettle.returns(
                parseEther("1000"),
                parseEther("4000"),
                parseWbtc("1"),
                parseWbtc("4"),
                0
            );
            const oldP = await fund.shareBalanceOf(TRANCHE_P, primaryMarket.address);
            await expect(() => fund.settle()).to.changeTokenBalances(
                wbtc,
                [fund, primaryMarket],
                [parseWbtc("-3").sub(managementFee), parseWbtc("3")]
            );
            expect(await fund.shareBalanceOf(TRANCHE_P, primaryMarket.address)).to.equal(
                oldP.sub(parseEther("3000"))
            );
        });

        it("Should transfer all fee to governance", async function () {
            // Create 900 shares with 1 WBTC (10% fee)
            // Redeem 4000 shares for 3.6 WBTC (10% fee)
            // There's also 50 shares (0.05 WBTC) charged as split and merge fee.
            // Fee: 0.1 from creation, 0.4 from redemption, 0.05 from split and merge
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            const totalFee = parseWbtc("0.55");
            await primaryMarketSettle.returns(
                parseEther("900"),
                parseEther("4050"),
                parseWbtc("1"),
                parseWbtc("3.6"),
                totalFee
            );
            await expect(() => fund.settle()).to.changeTokenBalances(
                wbtc,
                [fund, primaryMarket, governance],
                [
                    parseWbtc("-2.6").sub(totalFee).sub(managementFee),
                    parseWbtc("2.6"),
                    totalFee.add(managementFee),
                ]
            );
        });

        it("Should update NAV according to primary market operations", async function () {
            // Create 9000 shares with 10 WBTC (10% fee)
            // Redeem 4000 shares for 3.6 WBTC (10% fee)
            // There's also 500 shares (0.5 WBTC) charged as split and merge fee.
            // Fee: 1 from creation, 0.4 from redemption, 0.5 from split and merge
            await wbtc.mint(primaryMarket.address, parseWbtc("10"));
            const totalFee = parseWbtc("1.9");
            await primaryMarketSettle.returns(
                parseEther("9000"),
                parseEther("4500"),
                parseWbtc("10"),
                parseWbtc("3.6"),
                totalFee
            );
            const newWbtcInFund = wbtcInFund.add(parseWbtc("6.4")).sub(totalFee);
            const navP = newWbtcInFund.mul(1e10).mul(1000).div(14500);
            const navB = navP.mul(2).sub(navA);
            // Note that NAV drops below 1 after management fee but creation and redemption are
            // still executed at NAV = 1 in this case. Because creation is more than redemption
            // and split/merge fee, the final navP is a bit higher than that if nothing happened.
            const navPLowerBound = wbtcInFund.mul(1e10).mul(1000).div(10000); // NAV of Share P if nothing happened
            expect(navP).to.be.gt(navPLowerBound);
            expect(navP).to.be.lt(parseEther("1"));

            await expect(fund.settle())
                .to.emit(fund, "Settled")
                .withArgs(startDay + DAY, navP, navA, navB);
            const navs = await fund.historyNavs(startDay + DAY);
            expect(navs[TRANCHE_P]).to.equal(navP);
            expect(navs[TRANCHE_A]).to.equal(navA);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });

        it("Should not trigger upper conversion when price is not high enough", async function () {
            const price = parseEther("1500");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navP = wbtcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            expect(navP).to.be.lt(UPPER_CONVERSION_THRESHOLD);
            await fund.settle();
            expect(await fund.getConversionSize()).to.equal(0);
            const navs = await fund.historyNavs(startDay + DAY);
            expect(navs[TRANCHE_P]).to.equal(navP);
        });

        it("Should trigger upper conversion when price is high enough", async function () {
            const price = parseEther("1510");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navP = wbtcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            expect(navP).to.be.gt(UPPER_CONVERSION_THRESHOLD);
            await fund.settle();
            expect(await fund.getConversionSize()).to.equal(1);
            const navs = await fund.historyNavs(startDay + DAY);
            expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
        });

        it("Should not trigger lower conversion when price is not low enough", async function () {
            const price = parseEther("755");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navP = wbtcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            const navB = navP.mul(2).sub(navA);
            expect(navB).to.be.gt(LOWER_CONVERSION_THRESHOLD);
            await fund.settle();
            expect(await fund.getConversionSize()).to.equal(0);
            const navs = await fund.historyNavs(startDay + DAY);
            expect(navs[TRANCHE_B]).to.equal(navB);
        });

        it("Should trigger lower conversion when price is low enough", async function () {
            const price = parseEther("750");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarketSettleAtPrice(price).returns(0, 0, 0, 0, 0);
            const navP = wbtcInFund.mul(1e10).mul(price).div(parseEther("10000"));
            const navB = navP.mul(2).sub(navA);
            expect(navB).to.be.lt(LOWER_CONVERSION_THRESHOLD);
            await fund.settle();
            expect(await fund.getConversionSize()).to.equal(1);
            const navs = await fund.historyNavs(startDay + DAY);
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
        });
    });

    describe("extrapolateNav()", function () {
        it("Should return ones before any shares are created", async function () {
            expect(await fund.extrapolateNavP(startDay - DAY * 10, parseEther("8000"))).to.equal(
                parseEther("1")
            );
            expect(await fund.extrapolateNavA(startDay - DAY * 10)).to.equal(parseEther("1"));
            const navs = await fund.extrapolateNav(startDay - DAY * 10, parseEther("8000"));
            expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
            expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
        });

        it("Should return the previous settlement if fund is empty", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseWbtc("1"), 0, 0);
            await advanceOneDayAndSettle();

            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();
            // All shares redeemed on settlement
            const emptyDay = (await fund.currentDay()).toNumber();
            const redeemedWbtc = (await wbtc.balanceOf(fund.address))
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            await primaryMarket.mock.settle.returns(0, parseEther("1000"), 0, redeemedWbtc, 0);
            await advanceOneDayAndSettle();
            // Create the shares again
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, redeemedWbtc, 0, 0);
            await advanceOneDayAndSettle();

            const expectedP = parseEther("1")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedA = parseEther("1.001")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedB = expectedP.mul(2).sub(expectedA);
            expect(await fund.extrapolateNavP(emptyDay, parseEther("8000"))).to.eq(expectedP);
            expect(await fund.extrapolateNavA(emptyDay)).to.eq(expectedA);
            const startNavs = await fund.extrapolateNav(emptyDay, parseEther("8000"));
            expect(startNavs[TRANCHE_P]).to.equal(expectedP);
            expect(startNavs[TRANCHE_A]).to.equal(expectedA);
            expect(startNavs[TRANCHE_B]).to.equal(expectedB);
            expect(await fund.extrapolateNavP(emptyDay + DAY - 1, parseEther("8000"))).to.eq(
                expectedP
            );
            expect(await fund.extrapolateNavA(emptyDay + DAY - 1)).to.eq(expectedA);
            const endNavs = await fund.extrapolateNav(emptyDay + DAY - 1, parseEther("8000"));
            expect(endNavs[TRANCHE_P]).to.equal(expectedP);
            expect(endNavs[TRANCHE_A]).to.equal(expectedA);
            expect(endNavs[TRANCHE_B]).to.equal(expectedB);
        });

        it("Should use the price", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseWbtc("1"), 0, 0);
            await advanceOneDayAndSettle();
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

            const day = (await fund.currentDay()).toNumber();
            await advanceOneDayAndSettle();

            const expectedA = parseEther("1.001")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedP1000 = parseEther("1")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedB1000 = expectedP1000.mul(2).sub(expectedA);
            expect(await fund.extrapolateNavP(day, parseEther("1000"))).to.equal(expectedP1000);
            expect(await fund.extrapolateNavA(day)).to.equal(expectedA);
            const navsAt1000 = await fund.extrapolateNav(day, parseEther("1000"));
            expect(navsAt1000[TRANCHE_P]).to.equal(expectedP1000);
            expect(navsAt1000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt1000[TRANCHE_B]).to.equal(expectedB1000);

            const expectedP2000 = parseEther("2")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedB2000 = expectedP2000.mul(2).sub(expectedA);
            expect(await fund.extrapolateNavP(day, parseEther("2000"))).to.equal(expectedP2000);
            expect(await fund.extrapolateNavA(day)).to.equal(expectedA);
            const navsAt2000 = await fund.extrapolateNav(day, parseEther("2000"));
            expect(navsAt2000[TRANCHE_P]).to.equal(expectedP2000);
            expect(navsAt2000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt2000[TRANCHE_B]).to.equal(expectedB2000);
        });

        it("Should accrue management fee and interest", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseWbtc("1"), 0, 0);
            await advanceOneDayAndSettle();
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

            const day = (await fund.currentDay()).toNumber();
            await advanceOneDayAndSettle();

            const navPAtDay = parseEther("1")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedP = navPAtDay.mul(20000 - DAILY_MANAGEMENT_FEE_BPS).div(20000);
            const navAAtDay = parseEther("1.001")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedA = navAAtDay
                .mul(10005)
                .div(10000)
                .mul(20000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(20000);
            const expectedB = expectedP.mul(2).sub(expectedA);
            expect(await fund.extrapolateNavP(day + DAY / 2, parseEther("1000"))).to.equal(
                expectedP
            );
            expect(await fund.extrapolateNavA(day + DAY / 2)).to.equal(expectedA);
            const navsAt1000 = await fund.extrapolateNav(day + DAY / 2, parseEther("1000"));
            expect(navsAt1000[TRANCHE_P]).to.equal(expectedP);
            expect(navsAt1000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt1000[TRANCHE_B]).to.equal(expectedB);
        });

        it("Should predict NAV in the future", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day
            await wbtc.mint(primaryMarket.address, parseWbtc("1"));
            await primaryMarket.mock.settle.returns(parseEther("1000"), 0, parseWbtc("1"), 0, 0);
            await advanceOneDayAndSettle();
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);

            const day = (await fund.currentDay()).toNumber();
            await advanceOneDayAndSettle();

            const navPAtDay = parseEther("1")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedP = navPAtDay.mul(10000 - DAILY_MANAGEMENT_FEE_BPS * 10).div(10000);
            const navAAtDay = parseEther("1.001")
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS)
                .div(10000);
            const expectedA = navAAtDay
                .mul(101)
                .div(100)
                .mul(10000 - DAILY_MANAGEMENT_FEE_BPS * 10)
                .div(10000);
            const expectedB = expectedP.mul(2).sub(expectedA);
            expect(await fund.extrapolateNavP(day + DAY * 10, parseEther("1000"))).to.equal(
                expectedP
            );
            expect(await fund.extrapolateNavA(day + DAY * 10)).to.equal(expectedA);
            const navsAt1000 = await fund.extrapolateNav(day + DAY * 10, parseEther("1000"));
            expect(navsAt1000[TRANCHE_P]).to.equal(expectedP);
            expect(navsAt1000[TRANCHE_A]).to.equal(expectedA);
            expect(navsAt1000[TRANCHE_B]).to.equal(expectedB);
        });

        it("Should keep NAV of Share A non-decreasing", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            // Interest of Share A is smaller than management fee
            await aprOracle.mock.capture.returns(
                parseEther("0.0001").mul(DAILY_MANAGEMENT_FEE_BPS).div(2)
            );
            await primaryMarket.mock.settle.returns(0, 0, 0, 0, 0);
            await advanceOneDayAndSettle();

            const day = (await fund.currentDay()).toNumber();
            await primaryMarket.call(fund, "mint", TRANCHE_P, addr1, parseEther("1000"));
            await wbtc.mint(fund.address, parseWbtc("1"));
            await advanceOneDayAndSettle();

            expect(await fund.extrapolateNavA(day + DAY / 2)).to.equal(parseEther("1"));
            expect(await fund.extrapolateNavA(day + DAY * 10)).to.equal(parseEther("1"));
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

        // Overwrite the fund with a new one with zero management fee
        const Fund = await ethers.getContractFactory("Fund");
        f.fund = await Fund.connect(f.wallets.owner).deploy(
            0, // Zero management fee
            UPPER_CONVERSION_THRESHOLD,
            LOWER_CONVERSION_THRESHOLD,
            FIXED_CONVERSION_THRESHOLD,
            f.twapOracle.address
        );
        await f.fund.initialize(
            f.wbtc.address,
            8,
            f.wallets.shareP.address,
            f.wallets.shareA.address,
            f.wallets.shareB.address,
            f.aprOracle.address,
            f.interestRateBallot.address,
            f.primaryMarket.address,
            f.wallets.governance.address
        );
        return f;
    }

    describe("Conversion trigger conditions", function () {
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

        it("Should not trigger at exactly upper conversion threshold", async function () {
            await primaryMarket.call(fund, "mint", TRANCHE_P, addr1, parseEther("1000"));
            await wbtc.mint(fund.address, parseWbtc("1.5"));
            await advanceOneDayAndSettle();
            expect(await fund.getConversionSize()).to.equal(0);
            const navs = await fund.historyNavs(startDay);
            expect(navs[TRANCHE_P]).to.equal(parseEther("1.5"));
        });

        it("Should not trigger at exactly lower conversion threshold", async function () {
            await primaryMarket.call(fund, "mint", TRANCHE_P, addr1, parseEther("1000"));
            await wbtc.mint(fund.address, parseWbtc("0.75"));
            await advanceOneDayAndSettle();
            expect(await fund.getConversionSize()).to.equal(0);
            const navs = await fund.historyNavs(startDay);
            expect(navs[TRANCHE_B]).to.equal(parseEther("0.5"));
        });

        it("Should not trigger at exactly fixed conversion threshold", async function () {
            // Set daily interest rate to 10%
            await aprOracle.mock.capture.returns(parseEther("0.1"));
            await primaryMarket.call(fund, "mint", TRANCHE_P, addr1, parseEther("1000"));
            await wbtc.mint(fund.address, parseWbtc("1"));
            await advanceOneDayAndSettle();

            await advanceOneDayAndSettle();
            expect(await fund.getConversionSize()).to.equal(0);
            const navs = await fund.historyNavs(startDay + DAY);
            expect(navs[TRANCHE_A]).to.equal(parseEther("1.1"));
        });
    });

    describe("Conversion", function () {
        let outerFixture: Fixture<FixtureData>;

        // Initial balances
        // User 1: 400 P + 100 A
        // User 2:         200 A + 300 B
        // Total:  400 P + 300 A + 300 B = 1000 total shares
        const INIT_P_1 = parseEther("400");
        const INIT_A_1 = parseEther("100");
        const INIT_B_1 = parseEther("0");
        const INIT_P_2 = parseEther("0");
        const INIT_A_2 = parseEther("200");
        const INIT_B_2 = parseEther("300");
        const INIT_WBTC = parseWbtc("1");

        async function conversionFixture(): Promise<FixtureData> {
            const f = await loadFixture(zeroFeeFixture);
            // Set daily interest rate to 10%
            await f.aprOracle.mock.capture.returns(parseEther("0.1"));
            await advanceBlockAtTime(f.startDay);
            await f.fund.settle();
            const addr1 = f.wallets.user1.address;
            const addr2 = f.wallets.user2.address;
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_P, addr1, INIT_P_1);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_A, addr1, INIT_A_1);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_B, addr1, INIT_B_1);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_P, addr2, INIT_P_2);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_A, addr2, INIT_A_2);
            await f.primaryMarket.call(f.fund, "mint", TRANCHE_B, addr2, INIT_B_2);
            await f.wbtc.mint(f.fund.address, INIT_WBTC);
            await advanceBlockAtTime(f.startDay + DAY);
            await f.fund.settle();
            return f;
        }

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = conversionFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        // Trigger a new conversion at the given NAV of Share P
        async function mockConversion(navP: BigNumber) {
            const lastPrice = await twapOracle.getTwap(0);
            const newPrice = lastPrice.mul(navP).div(parseEther("1"));
            await twapOracle.mock.getTwap.returns(newPrice);
            await advanceOneDayAndSettle();
        }

        // NAV before conversion: (1.6, 1.1, 2.1)
        // 1 P => 1.6 P'
        // 1 A => 0.1 P' + 1 A'
        // 1 B => 1.1 P'        + 1 B'
        const preDefinedConvert160 = () => mockConversion(parseEther("1.6"));

        // NAV before conversion: (2.0, 1.1, 2.9)
        // 1 P => 2.0 P'
        // 1 A => 0.1 P' + 1 A'
        // 1 B => 1.9 P'        + 1 B'
        const preDefinedConvert200 = () => mockConversion(parseEther("2"));

        // NAV before conversion: (0.7, 1.1, 0.3)
        // 1 P => 0.7 P'
        // 1 A => 0.8 P' + 0.3 A'
        // 1 B =>                   0.3 B'
        const preDefinedConvert070 = () => mockConversion(parseEther("0.7"));

        // NAV before conversion: (0.4, 1.1, -0.3)
        // 1 P => 0.4 P'
        // 1 A => 0.8 P'
        // 1 B => 0
        const preDefinedConvert040 = () => mockConversion(parseEther("0.4"));

        describe("Conversion matrix", function () {
            it("Upper conversion", async function () {
                await preDefinedConvert160();
                expect(await fund.getConversionSize()).to.equal(1);
                const navs = await fund.historyNavs(startDay + DAY);
                expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                const conversion = await fund.getConversion(0);
                expect(conversion.ratioP).to.equal(parseEther("1.6"));
                expect(conversion.ratioA2P).to.equal(parseEther("0.1"));
                expect(conversion.ratioB2P).to.equal(parseEther("1.1"));
                expect(conversion.ratioAB).to.equal(parseEther("1"));
                expect(conversion.day).to.equal(startDay + DAY * 2);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(parseEther("650"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(parseEther("100"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(parseEther("350"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(parseEther("200"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("300"));
                expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(parseEther("1000"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(parseEther("300"));
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(parseEther("300"));
                expect(await fund.getTotalShares()).to.equal(parseEther("1600"));
            });

            it("Lower conversion", async function () {
                await preDefinedConvert070();
                await advanceOneDayAndSettle();
                expect(await fund.getConversionSize()).to.equal(1);
                const navs = await fund.historyNavs(startDay + DAY * 2);
                expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                const conversion = await fund.getConversion(0);
                expect(conversion.ratioP).to.equal(parseEther("0.7"));
                expect(conversion.ratioA2P).to.equal(parseEther("0.8"));
                expect(conversion.ratioB2P).to.equal(0);
                expect(conversion.ratioAB).to.equal(parseEther("0.3"));
                expect(conversion.day).to.equal(startDay + DAY * 2);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(parseEther("360"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(parseEther("30"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(parseEther("160"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(parseEther("60"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("90"));
                expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(parseEther("520"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(parseEther("90"));
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(parseEther("90"));
                expect(await fund.getTotalShares()).to.equal(parseEther("700"));
            });

            it("Lower conversion with negative NAV of Share B", async function () {
                await preDefinedConvert040();
                expect(await fund.getConversionSize()).to.equal(1);
                const navs = await fund.historyNavs(startDay + DAY * 2);
                expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                const conversion = await fund.getConversion(0);
                expect(conversion.ratioP).to.equal(parseEther("0.4"));
                expect(conversion.ratioA2P).to.equal(parseEther("0.8"));
                expect(conversion.ratioB2P).to.equal(0);
                expect(conversion.ratioAB).to.equal(0);
                expect(conversion.day).to.equal(startDay + DAY * 2);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(parseEther("240"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(parseEther("160"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(0);
                expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(parseEther("400"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(0);
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(0);
                expect(await fund.getTotalShares()).to.equal(parseEther("400"));
            });

            it("Fixed conversion when navA > navB", async function () {
                await advanceOneDayAndSettle();
                expect(await fund.getConversionSize()).to.equal(0);

                // NAV before conversion: (1, 1.21, 0.79)
                await advanceOneDayAndSettle();
                expect(await fund.getConversionSize()).to.equal(1);
                const navs = await fund.historyNavs(startDay + DAY * 3);
                expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                // 1 P => 1    P'
                // 1 A => 0.42 P' + 0.79 A'
                // 1 B =>                     0.79 B'
                const conversion = await fund.getConversion(0);
                expect(conversion.ratioP).to.equal(parseEther("1"));
                expect(conversion.ratioA2P).to.equal(parseEther("0.42"));
                expect(conversion.ratioB2P).to.equal(0);
                expect(conversion.ratioAB).to.equal(parseEther("0.79"));
                expect(conversion.day).to.equal(startDay + DAY * 3);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(parseEther("442"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(parseEther("79"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(parseEther("84"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(parseEther("158"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("237"));
                expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(parseEther("526"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(parseEther("237"));
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(parseEther("237"));
                expect(await fund.getTotalShares()).to.equal(parseEther("1000"));
            });

            it("Fixed conversion when navA < navB", async function () {
                await twapOracle.mock.getTwap.returns(parseEther("1400"));
                await advanceOneDayAndSettle();
                expect(await fund.getConversionSize()).to.equal(0);

                // NAV before conversion: (1.4, 1.21, 0.99)
                await advanceOneDayAndSettle();
                expect(await fund.getConversionSize()).to.equal(1);
                const navs = await fund.historyNavs(startDay + DAY * 3);
                expect(navs[TRANCHE_P]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_A]).to.equal(parseEther("1"));
                expect(navs[TRANCHE_B]).to.equal(parseEther("1"));
                // 1 P => 1.4  P'
                // 1 A => 0.21 P' + 1 A'
                // 1 B => 0.59 P'        + 1 B'
                const conversion = await fund.getConversion(0);
                expect(conversion.ratioP).to.equal(parseEther("1.4"));
                expect(conversion.ratioA2P).to.equal(parseEther("0.21"));
                expect(conversion.ratioB2P).to.equal(parseEther("0.59"));
                expect(conversion.ratioAB).to.equal(parseEther("1"));
                expect(conversion.day).to.equal(startDay + DAY * 3);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(parseEther("581"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(parseEther("100"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr2)).to.equal(parseEther("219"));
                expect(await fund.shareBalanceOf(TRANCHE_A, addr2)).to.equal(parseEther("200"));
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("300"));
                expect(await fund.shareTotalSupply(TRANCHE_P)).to.equal(parseEther("800"));
                expect(await fund.shareTotalSupply(TRANCHE_A)).to.equal(parseEther("300"));
                expect(await fund.shareTotalSupply(TRANCHE_B)).to.equal(parseEther("300"));
                expect(await fund.getTotalShares()).to.equal(parseEther("1400"));
            });
        });

        describe("convert()", function () {
            it("Should use conversion at the specified index", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                await preDefinedConvert160(); // This one is selected
                await preDefinedConvert040();
                const [p, a, b] = await fund.convert(100000, 1000, 10, 2);
                expect(p).to.equal(160111);
                expect(a).to.equal(1000);
                expect(b).to.equal(10);
            });

            it("Should round down the result", async function () {
                await preDefinedConvert200();
                expect((await fund.convert(1, 0, 0, 0))[0]).to.equal(2);
                expect((await fund.convert(0, 1, 0, 0))[0]).to.equal(0);
                expect((await fund.convert(0, 0, 1, 0))[0]).to.equal(1);
                // Precise value is 2.0 + 0.1 + 1.9 = 4.0
                expect((await fund.convert(1, 1, 1, 0))[0]).to.equal(3);
            });
        });

        describe("batchConvert()", function () {
            it("Should use conversion at the specified index range", async function () {
                await preDefinedConvert040();
                await preDefinedConvert070();
                await preDefinedConvert200();
                await preDefinedConvert160();
                const [p, a, b] = await fund.batchConvert(1000, 1000, 1000, 1, 4);
                expect(p).to.equal(6120);
                expect(a).to.equal(300);
                expect(b).to.equal(300);
            });
        });

        describe("getConversion()", function () {
            it("Should return the conversion struct at the given index", async function () {
                await preDefinedConvert070();
                await preDefinedConvert040();
                await preDefinedConvert160();
                await preDefinedConvert200();
                const conversion = await fund.getConversion(2);
                expect(conversion.ratioP).to.equal(parseEther("1.6"));
                expect(conversion.ratioA2P).to.equal(parseEther("0.1"));
                expect(conversion.ratioB2P).to.equal(parseEther("1.1"));
                expect(conversion.ratioAB).to.equal(parseEther("1"));
                expect(conversion.day).to.equal(startDay + DAY * 4);
            });

            it("Should return zeros if the given index is out of bound", async function () {
                await preDefinedConvert070();
                await preDefinedConvert040();
                await preDefinedConvert160();
                await preDefinedConvert200();
                const conversion = await fund.getConversion(4);
                expect(conversion.ratioP).to.equal(0);
                expect(conversion.ratioA2P).to.equal(0);
                expect(conversion.ratioB2P).to.equal(0);
                expect(conversion.ratioAB).to.equal(0);
                expect(conversion.day).to.equal(0);
            });
        });

        describe("getConversionTimestamp()", function () {
            it("Should return the trading day of a given conversion", async function () {
                await preDefinedConvert070();
                await preDefinedConvert040();
                await preDefinedConvert160();
                await preDefinedConvert200();
                expect(await fund.getConversionTimestamp(2)).to.equal(startDay + DAY * 4);
            });

            it("Should return zero if the given index is out of bound", async function () {
                await preDefinedConvert070();
                await preDefinedConvert040();
                await preDefinedConvert160();
                await preDefinedConvert200();
                expect(await fund.getConversionTimestamp(4)).to.equal(0);
            });
        });

        describe("Balance refresh on interaction", function () {
            it("No refresh when conversion is triggered", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                expect(await fund.shareBalanceVersion(addr1)).to.equal(0);
                expect(await fund.shareBalanceVersion(addr2)).to.equal(0);
            });

            it("transfer()", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                const oldA1 = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB2 = await fund.shareBalanceOf(TRANCHE_B, addr2);
                await advanceOneDayAndSettle();
                await fund.connect(shareP).transfer(TRANCHE_P, addr1, addr2, 1);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(2);
                expect(await fund.shareBalanceVersion(addr2)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA1);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(oldB2);
            });

            it("mint()", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                await primaryMarket.call(fund, "mint", TRANCHE_P, addr1, 1);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
            });

            it("burn()", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr2);
                await primaryMarket.call(fund, "burn", TRANCHE_A, addr2, 1);
                expect(await fund.shareBalanceVersion(addr2)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr2)).to.equal(oldB);
            });
        });

        describe("refreshBalance()", function () {
            it("Non-zero targetVersion", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                await preDefinedConvert160();
                await preDefinedConvert040();
                await preDefinedConvert070();
                const oldP = await fund.shareBalanceOf(TRANCHE_P, addr1);
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr1);
                await fund.refreshBalance(addr1, 2);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(2);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(oldP);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
                await fund.refreshBalance(addr1, 5);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(5);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(oldP);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
            });

            it("Zero targetVersion", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                await preDefinedConvert160();
                const oldP = await fund.shareBalanceOf(TRANCHE_P, addr1);
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr1);
                await fund.refreshBalance(addr1, 0);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(3);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(oldP);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
            });

            it("Should make no change if targetVersion is older", async function () {
                await preDefinedConvert070();
                await preDefinedConvert200();
                await preDefinedConvert160();
                const oldP = await fund.shareBalanceOf(TRANCHE_P, addr1);
                const oldA = await fund.shareBalanceOf(TRANCHE_A, addr1);
                const oldB = await fund.shareBalanceOf(TRANCHE_B, addr1);
                await fund.refreshBalance(addr1, 3);
                await fund.refreshBalance(addr1, 1);
                expect(await fund.shareBalanceVersion(addr1)).to.equal(3);
                expect(await fund.shareBalanceOf(TRANCHE_P, addr1)).to.equal(oldP);
                expect(await fund.shareBalanceOf(TRANCHE_A, addr1)).to.equal(oldA);
                expect(await fund.shareBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
            });
        });
    });
});
