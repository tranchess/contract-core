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
    TRANCHE_B,
    TRANCHE_R,
    DAY,
    HOUR,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";

const BTC_TO_ETHER = parseUnits("1", 10);
const POST_REBALANCE_DELAY_TIME = HOUR / 2;
const UPPER_REBALANCE_THRESHOLD = parseEther("2");
const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");
const ROLE_UPDATE_MIN_DELAY = DAY * 3;
const ROLE_UPDATE_MAX_DELAY = DAY * 15;

describe("FundV3", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startDay: number;
        readonly startTimestamp: number;
        readonly twapOracle: MockContract;
        readonly btc: Contract;
        readonly aprOracle: MockContract;
        readonly interestRateBallot: MockContract;
        readonly shareQ: MockContract;
        readonly shareB: MockContract;
        readonly shareR: MockContract;
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
    let feeCollector: Wallet;
    let strategy: Wallet;
    let addr1: string;
    let addr2: string;
    let twapOracle: MockContract;
    let btc: Contract;
    let aprOracle: MockContract;
    let interestRateBallot: MockContract;
    let shareQ: MockContract;
    let shareB: MockContract;
    let shareR: MockContract;
    let primaryMarket: MockContract;
    let fund: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        // Initiating transactions from a Waffle mock contract doesn't work well in Hardhat
        // and may fail with gas estimating errors. We use EOAs for the shares to make
        // test development easier.
        const [user1, user2, owner, feeCollector, strategy] = provider.getWallets();

        // Start at 12 hours after settlement time of the 6th day in a week, which makes sure that
        // the first settlement after the fund's deployment settles the last day in a week and
        // starts a new week by updating interest rate of BISHOP. Many test cases in this file
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
        await btc.mint(user1.address, parseBtc("10000"));
        await btc.mint(user2.address, parseBtc("10000"));

        const aprOracle = await deployMockForName(owner, "IAprOracle");
        await aprOracle.mock.capture.returns(parseEther("0.001")); // 0.1% per day

        const interestRateBallot = await deployMockForName(owner, "IBallot");
        await interestRateBallot.mock.count.returns(0);

        const shareQ = await deployMockForName(owner, "IShareV2");
        const shareB = await deployMockForName(owner, "IShareV2");
        const shareR = await deployMockForName(owner, "IShareV2");
        for (const share of [shareQ, shareB, shareR]) {
            await share.mock.fundEmitTransfer.returns();
            await share.mock.fundEmitApproval.returns();
        }
        const primaryMarket = await deployMockForName(owner, "IPrimaryMarketV3");
        await primaryMarket.mock.settle.returns();

        const Fund = await ethers.getContractFactory("FundV3");
        const fund = await Fund.connect(owner).deploy([
            btc.address,
            8,
            shareQ.address,
            shareB.address,
            shareR.address,
            primaryMarket.address,
            ethers.constants.AddressZero,
            0,
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracle.address,
            aprOracle.address,
            interestRateBallot.address,
            feeCollector.address,
        ]);
        await fund.initialize(parseEther("500"), parseEther("1"), parseEther("1"));

        return {
            wallets: { user1, user2, owner, feeCollector, strategy },
            startDay,
            startTimestamp,
            twapOracle,
            btc,
            aprOracle,
            interestRateBallot,
            shareQ,
            shareB,
            shareR,
            primaryMarket,
            fund: fund.connect(user1),
        };
    }

    async function advanceOneDayAndSettle() {
        await advanceBlockAtTime((await fund.currentDay()).toNumber());
        await fund.settle();
    }

    async function pmCreate(
        user: Wallet,
        inBtc: BigNumberish,
        outQ: BigNumberish,
        version?: number
    ): Promise<void> {
        await btc.connect(user).transfer(fund.address, inBtc);
        await primaryMarket.call(
            fund,
            "primaryMarketMint",
            TRANCHE_Q,
            user.address,
            outQ,
            version ?? 0
        );
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
        strategy = fixtureData.wallets.strategy;
        addr1 = user1.address;
        addr2 = user2.address;
        startDay = fixtureData.startDay;
        startTimestamp = fixtureData.startTimestamp;
        twapOracle = fixtureData.twapOracle;
        btc = fixtureData.btc;
        aprOracle = fixtureData.aprOracle;
        interestRateBallot = fixtureData.interestRateBallot;
        shareQ = fixtureData.shareQ;
        shareB = fixtureData.shareB;
        shareR = fixtureData.shareR;
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

    // TODO move to rebalance session
    describe("isFundActive()", function () {
        it("Should revert transfer when inactive", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await pmCreate(user1, parseBtc("1"), parseEther("500"));
            await advanceOneDayAndSettle();

            expect(await fund.isFundActive(startDay + POST_REBALANCE_DELAY_TIME - 1)).to.equal(
                false
            );
            await expect(shareQ.call(fund, "shareTransfer", addr1, addr2, 0)).to.be.revertedWith(
                "Transfer is inactive"
            );
        });

        it("Should return the activity window without rebalance", async function () {
            expect(await fund.fundActivityStartTime()).to.equal(startDay - DAY);
            expect(await fund.currentDay()).to.equal(startDay);
            expect(await fund.isFundActive(startDay - DAY + POST_REBALANCE_DELAY_TIME)).to.equal(
                true
            );

            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(startDay);
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(await fund.isFundActive(startDay + POST_REBALANCE_DELAY_TIME)).to.equal(true);
        });

        it("Should return the activity window with rebalance", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await pmCreate(user1, parseBtc("1"), parseEther("500"));
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
            await advanceOneDayAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(startDay);
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(
                await fund.isPrimaryMarketActive(primaryMarket.address, startDay + HOUR * 12)
            ).to.equal(true);
        });

        it("Should return the activity window with rebalance", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1510"));
            await pmCreate(user1, parseBtc("1"), parseEther("500"));
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

    describe("FundRoles", function () {
        describe("Primary market and strategy", function () {
            let newPm: MockContract;

            beforeEach(async function () {
                newPm = await deployMockForName(owner, "IPrimaryMarketV3");
                await primaryMarket.mock.canBeRemovedFromFund.returns(true);
            });

            it("Should revert if not proposed by owner", async function () {
                await expect(fund.proposePrimaryMarketUpdate(newPm.address)).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );
                await expect(fund.proposeStrategyUpdate(strategy.address)).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );
            });

            it("Should revert if the original address is proposed", async function () {
                await expect(fund.connect(owner).proposePrimaryMarketUpdate(primaryMarket.address))
                    .to.be.reverted;
                await expect(fund.connect(owner).proposeStrategyUpdate(await fund.strategy())).to.be
                    .reverted;
            });

            it("Should save proposed change", async function () {
                await fund.connect(owner).proposePrimaryMarketUpdate(newPm.address);
                expect(await fund.proposedPrimaryMarket()).to.equal(newPm.address);
                await fund.connect(owner).proposeStrategyUpdate(strategy.address);
                expect(await fund.proposedStrategy()).to.equal(strategy.address);
            });

            it("Should emit event on proposal", async function () {
                const t = startTimestamp + HOUR;
                await setNextBlockTime(t);
                await expect(fund.connect(owner).proposePrimaryMarketUpdate(newPm.address))
                    .to.emit(fund, "PrimaryMarketUpdateProposed")
                    .withArgs(newPm.address, t + ROLE_UPDATE_MIN_DELAY, t + ROLE_UPDATE_MAX_DELAY);
                await setNextBlockTime(t + 100);
                await expect(fund.connect(owner).proposeStrategyUpdate(strategy.address))
                    .to.emit(fund, "StrategyUpdateProposed")
                    .withArgs(
                        strategy.address,
                        t + 100 + ROLE_UPDATE_MIN_DELAY,
                        t + 100 + ROLE_UPDATE_MAX_DELAY
                    );
            });

            it("Should revert if not applied by owner", async function () {
                await expect(fund.applyPrimaryMarketUpdate(newPm.address)).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );
                await expect(fund.applyStrategyUpdate(strategy.address)).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );
            });

            it("Should revert if apply a different strategy change", async function () {
                await fund.connect(owner).proposePrimaryMarketUpdate(newPm.address);
                await expect(
                    fund.connect(owner).applyPrimaryMarketUpdate(addr1)
                ).to.be.revertedWith("Proposed address mismatch");
                await fund.connect(owner).proposeStrategyUpdate(strategy.address);
                await expect(fund.connect(owner).applyStrategyUpdate(addr1)).to.be.revertedWith(
                    "Proposed address mismatch"
                );
            });

            it("Should revert if apply too early or too late", async function () {
                const t = startTimestamp + HOUR;
                await setNextBlockTime(t);
                await fund.connect(owner).proposePrimaryMarketUpdate(newPm.address);
                await fund.connect(owner).proposeStrategyUpdate(strategy.address);

                await advanceBlockAtTime(t + ROLE_UPDATE_MIN_DELAY - 10);
                await expect(
                    fund.connect(owner).applyPrimaryMarketUpdate(newPm.address)
                ).to.be.revertedWith("Not ready to update");
                await expect(
                    fund.connect(owner).applyStrategyUpdate(strategy.address)
                ).to.be.revertedWith("Not ready to update");
                await advanceBlockAtTime(t + ROLE_UPDATE_MAX_DELAY + 10);
                await expect(
                    fund.connect(owner).applyPrimaryMarketUpdate(newPm.address)
                ).to.be.revertedWith("Not ready to update");
                await expect(
                    fund.connect(owner).applyStrategyUpdate(strategy.address)
                ).to.be.revertedWith("Not ready to update");
            });

            it("Should reject primary market change if it is not ready", async function () {
                await primaryMarket.mock.canBeRemovedFromFund.returns(false);
                const t = startTimestamp + HOUR;
                await setNextBlockTime(t);
                await fund.connect(owner).proposePrimaryMarketUpdate(newPm.address);
                await advanceBlockAtTime(t + ROLE_UPDATE_MIN_DELAY - 10);
                await expect(
                    fund.connect(owner).applyPrimaryMarketUpdate(newPm.address)
                ).to.be.revertedWith("Cannot update primary market");
            });

            it("Should reject strategy change with debt", async function () {
                await primaryMarket.call(fund, "primaryMarketAddDebt", 1, 0);
                const t = startTimestamp + HOUR;
                await setNextBlockTime(t);
                await fund.connect(owner).proposeStrategyUpdate(strategy.address);
                await advanceBlockAtTime(t + ROLE_UPDATE_MIN_DELAY - 10);
                await expect(
                    fund.connect(owner).applyStrategyUpdate(strategy.address)
                ).to.be.revertedWith("Cannot update strategy with debt");
            });

            it("Should update role", async function () {
                const t = startTimestamp + HOUR;
                await setNextBlockTime(t);
                await fund.connect(owner).proposePrimaryMarketUpdate(newPm.address);
                await fund.connect(owner).proposeStrategyUpdate(strategy.address);
                await advanceBlockAtTime(t + ROLE_UPDATE_MIN_DELAY + 10);
                await fund.connect(owner).applyPrimaryMarketUpdate(newPm.address);
                await fund.connect(owner).applyStrategyUpdate(strategy.address);
                expect(await fund.primaryMarket()).to.equal(newPm.address);
                expect(await fund.proposedPrimaryMarket()).to.equal(ethers.constants.AddressZero);
                expect(await fund.proposedPrimaryMarketTimestamp()).to.equal(0);
                expect(await fund.strategy()).to.equal(strategy.address);
                expect(await fund.proposedStrategy()).to.equal(ethers.constants.AddressZero);
                expect(await fund.proposedStrategyTimestamp()).to.equal(0);
            });
        });

        describe("Share", function () {
            it("Should initialize the three Share addresses", async function () {
                expect(await fund.tokenQ()).to.equal(shareQ.address);
                expect(await fund.tokenB()).to.equal(shareB.address);
                expect(await fund.tokenR()).to.equal(shareR.address);
            });
        });
    });

    describe("InterestRateBallot", function () {
        it("Should return the next settlement timestamp", async function () {
            expect(await fund.historicalInterestRate((await fund.currentDay()) - DAY)).to.equal(
                parseEther("0.001")
            );
            await interestRateBallot.mock.count.returns(parseEther("365"));
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await aprOracle.mock.capture.returns(0);
            await advanceOneDayAndSettle();
            expect(await fund.historicalInterestRate((await fund.currentDay()) - DAY)).to.equal(
                parseEther("1")
            );
        });
    });

    describe("Share balance management", function () {
        let outerFixture: Fixture<FixtureData>;

        let fundFromShares: { fundFromShare: Contract; tranche: number }[];

        async function fakePrimaryMarketFixture(): Promise<FixtureData> {
            const oldF = await loadFixture(deployFixture);
            const f = { ...oldF };
            await f.twapOracle.mock.getTwap.returns(parseEther("1000"));
            await advanceBlockAtTime((await f.fund.currentDay()).toNumber());
            await f.fund.settle();
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

        beforeEach(async function () {
            // Initiating transactions from a Waffle mock contract doesn't work well in Hardhat
            // and may fail with gas estimating errors. We impersonate the address and directly send
            // transactions from it to make test development easier.
            for (const contract of [primaryMarket, shareQ, shareB, shareR]) {
                await ethers.provider.send("hardhat_setBalance", [
                    contract.address,
                    parseEther("10").toHexString(),
                ]);
                await ethers.provider.send("hardhat_impersonateAccount", [contract.address]);
            }
            fund = fund.connect(await ethers.getSigner(primaryMarket.address));
            fundFromShares = [
                {
                    fundFromShare: fund.connect(await ethers.getSigner(shareQ.address)),
                    tranche: TRANCHE_Q,
                },
                {
                    fundFromShare: fund.connect(await ethers.getSigner(shareB.address)),
                    tranche: TRANCHE_B,
                },
                {
                    fundFromShare: fund.connect(await ethers.getSigner(shareR.address)),
                    tranche: TRANCHE_R,
                },
            ];
        });

        afterEach(async function () {
            for (const contract of [primaryMarket, shareQ, shareB, shareR]) {
                await ethers.provider.send("hardhat_stopImpersonatingAccount", [contract.address]);
            }
        });

        describe("primaryMarketMint()", function () {
            it("Should revert if not called from PrimaryMarket", async function () {
                await expect(
                    fund.connect(user1).primaryMarketMint(TRANCHE_Q, addr1, 1, 0)
                ).to.be.revertedWith("Only primary market");
            });

            it("Should revert if version mismatch", async function () {
                await expect(fund.primaryMarketMint(TRANCHE_Q, addr1, 1, 1)).to.be.revertedWith(
                    "Only current version"
                );
            });

            it("Should update balance and total supply", async function () {
                await fund.primaryMarketMint(TRANCHE_Q, addr1, 123, 0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(123);
                await fund.primaryMarketMint(TRANCHE_Q, addr1, 456, 0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(579);
                await fund.primaryMarketMint(TRANCHE_Q, addr2, 1000, 0);
                await fund.primaryMarketMint(TRANCHE_B, addr2, 10, 0);
                await fund.primaryMarketMint(TRANCHE_R, addr2, 100, 0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(1000);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(10);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(100);
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(1579);
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(10);
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(100);
            });

            it("Should revert on minting to the zero address", async function () {
                await expect(
                    fund.primaryMarketMint(TRANCHE_Q, ethers.constants.AddressZero, 100, 0)
                ).to.be.revertedWith("ERC20: mint to the zero address");
            });

            it("Should revert on overflow", async function () {
                const HALF_MAX = BigNumber.from("2").pow(255);
                await fund.primaryMarketMint(TRANCHE_Q, addr1, HALF_MAX, 0);
                await expect(fund.primaryMarketMint(TRANCHE_Q, addr1, HALF_MAX, 0)).to.be.reverted;
                await expect(fund.primaryMarketMint(TRANCHE_Q, addr2, HALF_MAX, 0)).to.be.reverted;
            });
        });

        describe("primaryMarketBurn()", function () {
            it("Should revert if not called from PrimaryMarket", async function () {
                await expect(
                    fund.connect(user1).primaryMarketBurn(TRANCHE_Q, addr1, 1, 0)
                ).to.be.revertedWith("Only primary market");
            });

            it("Should revert if version mismatch", async function () {
                await expect(fund.primaryMarketBurn(TRANCHE_Q, addr1, 1, 1)).to.be.revertedWith(
                    "Only current version"
                );
            });

            it("Should update balance and total supply", async function () {
                await fund.primaryMarketMint(TRANCHE_Q, addr1, 10000, 0);
                await fund.primaryMarketMint(TRANCHE_Q, addr2, 10000, 0);
                await fund.primaryMarketMint(TRANCHE_B, addr2, 10000, 0);
                await fund.primaryMarketMint(TRANCHE_R, addr2, 10000, 0);

                await fund.primaryMarketBurn(TRANCHE_Q, addr1, 1000, 0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(9000);
                await fund.primaryMarketBurn(TRANCHE_Q, addr1, 2000, 0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(7000);
                await fund.primaryMarketBurn(TRANCHE_Q, addr2, 100, 0);
                await fund.primaryMarketBurn(TRANCHE_B, addr2, 10, 0);
                await fund.primaryMarketBurn(TRANCHE_R, addr2, 1, 0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(9900);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(9990);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(9999);
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(16900);
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(9990);
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(9999);
            });

            it("Should revert on burning from the zero address", async function () {
                await expect(
                    fund.primaryMarketBurn(TRANCHE_Q, ethers.constants.AddressZero, 100, 0)
                ).to.be.revertedWith("ERC20: burn from the zero address");
            });

            it("Should revert if balance is not enough", async function () {
                await expect(fund.primaryMarketBurn(TRANCHE_Q, addr1, 1, 0)).to.be.reverted;
                await fund.primaryMarketMint(TRANCHE_Q, addr1, 100, 0);
                await expect(fund.primaryMarketBurn(TRANCHE_Q, addr1, 101, 0)).to.be.reverted;
            });
        });

        describe("transfer()", function () {
            it("Should revert if not called from Share", async function () {
                await expect(fund.shareTransfer(addr1, addr2, 1)).to.be.revertedWith("Only share");
            });

            it("Should reject transfer from the zero address", async function () {
                for (const { fundFromShare } of fundFromShares) {
                    await expect(
                        fundFromShare.shareTransfer(ethers.constants.AddressZero, addr1, 1)
                    ).to.be.revertedWith("ERC20: transfer from the zero address");
                }
            });

            it("Should reject transfer to the zero address", async function () {
                for (const { fundFromShare } of fundFromShares) {
                    await expect(
                        fundFromShare.shareTransfer(addr1, ethers.constants.AddressZero, 1)
                    ).to.be.revertedWith("ERC20: transfer to the zero address");
                }
            });

            it("Should update balance and keep total supply", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    await fund.primaryMarketMint(tranche, addr2, 10000, 0);
                    await fundFromShare.shareTransfer(addr2, addr1, 10000);
                    expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(10000);
                    expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(0);
                    expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(10000);
                }
            });

            it("Should revert if balance is not enough", async function () {
                for (const { fundFromShare } of fundFromShares) {
                    await expect(
                        fundFromShare.shareTransfer(addr2, addr1, 10001)
                    ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
                }
            });
        });

        describe("approve()", function () {
            it("Should revert if not called from Share", async function () {
                await expect(fund.shareApprove(addr1, addr2, 1)).to.be.revertedWith("Only share");
            });

            it("Should reject approval from the zero address", async function () {
                for (const { fundFromShare } of fundFromShares) {
                    await expect(
                        fundFromShare.shareApprove(ethers.constants.AddressZero, addr1, 1)
                    ).to.be.revertedWith("ERC20: approve from the zero address");
                }
            });

            it("Should reject approval to the zero address", async function () {
                for (const { fundFromShare } of fundFromShares) {
                    await expect(
                        fundFromShare.shareApprove(addr1, ethers.constants.AddressZero, 1)
                    ).to.be.revertedWith("ERC20: approve to the zero address");
                }
            });

            it("Should update allowance", async function () {
                for (const { fundFromShare, tranche } of fundFromShares) {
                    expect(await fund.trancheAllowance(tranche, addr1, addr2)).to.equal(0);
                    await fundFromShare.shareApprove(addr1, addr2, 100);
                    expect(await fund.trancheAllowance(tranche, addr1, addr2)).to.equal(100);
                    await fundFromShare.shareApprove(addr1, addr2, 10);
                    expect(await fund.trancheAllowance(tranche, addr1, addr2)).to.equal(10);
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
        it("Should keep previous NAV when nothing happened", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1100"));
            await advanceBlockAtTime(startDay);
            await expect(fund.settle())
                .to.emit(fund, "Settled")
                .withArgs(startDay, parseEther("1"), parseEther("1"));
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navB).to.equal(parseEther("1"));
            expect(navs.navR).to.equal(parseEther("1"));
        });
    });

    describe("Settlement of a non-empty fund", function () {
        const DAILY_PROTOCOL_FEE_BPS = 1; // 0.01% per day
        const protocolFee = parseBtc("10").mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
        const btcInFund = parseBtc("10").sub(protocolFee);
        const totalShares = parseEther("10000");
        const navB = parseEther("1.001");

        beforeEach(async function () {
            await fund
                .connect(owner)
                .updateDailyProtocolFeeRate(parseEther("0.0001").mul(DAILY_PROTOCOL_FEE_BPS));
            // Create 10 QUEEN with 10 BTC on the first day.
            await pmCreate(user1, parseBtc("10"), parseEther("10"));
            await twapOracle.mock.getTwap.withArgs(startDay).returns(parseEther("1000"));
        });

        it("Should charge protocol fee and interest", async function () {
            const navSum = btcInFund
                .mul(BTC_TO_ETHER)
                .mul(parseEther("1000"))
                .mul(2)
                .div(totalShares);
            const navR = navSum.sub(navB);
            await advanceBlockAtTime(startDay);
            await expect(fund.settle()).to.emit(fund, "Settled").withArgs(startDay, navB, navR);
            expect(await fund.currentDay()).to.equal(startDay + DAY);
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navB).to.equal(navB);
            expect(navs.navR).to.equal(navR);
        });

        it("Should transfer fee to the fee collector", async function () {
            const pmFee = parseBtc("0.1");
            await primaryMarket.call(fund, "primaryMarketAddDebt", 0, pmFee);
            const newProtocolFee = parseBtc("10").sub(pmFee).mul(DAILY_PROTOCOL_FEE_BPS).div(10000);
            const fee = newProtocolFee.add(pmFee);
            await expect(() => advanceOneDayAndSettle()).to.changeTokenBalances(
                btc,
                [feeCollector, fund],
                [fee, fee.mul(-1)]
            );
        });

        it("Should not trigger upper rebalance when price is not high enough", async function () {
            const price = parseEther("1500");
            await twapOracle.mock.getTwap.withArgs(startDay).returns(price);
            const navSum = btcInFund.mul(BTC_TO_ETHER).mul(price).mul(2).div(totalShares);
            const navR = navSum.sub(navB);
            const navROverB = navR.mul(parseEther("1")).div(navB);
            expect(navROverB).to.be.lt(UPPER_REBALANCE_THRESHOLD);
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navR).to.equal(navR);
        });

        it("Should trigger upper rebalance when price is high enough", async function () {
            const price = parseEther("1510");
            await twapOracle.mock.getTwap.withArgs(startDay).returns(price);
            const navSum = btcInFund.mul(BTC_TO_ETHER).mul(price).mul(2).div(totalShares);
            const navR = navSum.sub(navB);
            const navROverB = navR.mul(parseEther("1")).div(navB);
            expect(navROverB).to.be.gt(UPPER_REBALANCE_THRESHOLD);
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(1);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navR).to.equal(parseEther("1"));
        });

        it("Should not trigger lower rebalance when price is not low enough", async function () {
            const price = parseEther("755");
            await twapOracle.mock.getTwap.withArgs(startDay).returns(price);
            const navSum = btcInFund.mul(BTC_TO_ETHER).mul(price).mul(2).div(totalShares);
            const navR = navSum.sub(navB);
            const navROverB = navR.mul(parseEther("1")).div(navB);
            expect(navROverB).to.be.gt(LOWER_REBALANCE_THRESHOLD);
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navR).to.equal(navR);
        });

        it("Should trigger lower rebalance when price is low enough", async function () {
            const price = parseEther("750");
            await twapOracle.mock.getTwap.withArgs(startDay).returns(price);
            const navSum = btcInFund.mul(BTC_TO_ETHER).mul(price).mul(2).div(totalShares);
            const navR = navSum.sub(navB);
            const navROverB = navR.mul(parseEther("1")).div(navB);
            expect(navROverB).to.be.lt(LOWER_REBALANCE_THRESHOLD);
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(1);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navR).to.equal(parseEther("1"));
        });
    });

    describe("extrapolateNav()", function () {
        const DAILY_PROTOCOL_FEE_BPS = 1; // 0.01% per day

        beforeEach(async function () {
            await fund
                .connect(owner)
                .updateDailyProtocolFeeRate(parseEther("0.0001").mul(DAILY_PROTOCOL_FEE_BPS));
        });

        it("Should return the previous settlement if fund is empty", async function () {
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            await pmCreate(user1, parseBtc("1"), parseEther("1"));
            await advanceOneDayAndSettle();
            // Redeem everything
            await primaryMarket.call(
                fund,
                "primaryMarketBurn",
                TRANCHE_Q,
                addr1,
                parseEther("1"),
                0
            );
            await primaryMarket.call(
                fund,
                "primaryMarketTransferUnderlying",
                addr1,
                parseBtc("1")
                    .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                    .div(10000),
                0
            );

            const navSum = parseEther("2")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navB = parseEther("1.001");
            const navR = navSum.sub(navB);
            const startNavs = await fund.extrapolateNav(parseEther("8000"));
            expect(startNavs.navSum).to.equal(navSum);
            expect(startNavs.navB).to.equal(navB);
            expect(startNavs.navROrZero).to.equal(navR);
            await advanceBlockAtTime(startDay + DAY - 1);
            const endNavs = await fund.extrapolateNav(parseEther("8000"));
            expect(endNavs.navSum).to.equal(navSum);
            expect(endNavs.navB).to.equal(navB);
            expect(endNavs.navROrZero).to.equal(navR);
        });

        it("Should use the price", async function () {
            await pmCreate(user1, parseBtc("1"), parseEther("1"));
            await advanceBlockAtTime(startDay);

            const navB = parseEther("1.001");
            const navSum1000 = parseEther("2")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navR1000 = navSum1000.sub(navB);
            const navsAt1000 = await fund.extrapolateNav(parseEther("1000"));
            expect(navsAt1000.navSum).to.equal(navSum1000);
            expect(navsAt1000.navB).to.equal(navB);
            expect(navsAt1000.navROrZero).to.equal(navR1000);

            const navSum2000 = parseEther("4")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navR2000 = navSum2000.sub(navB);
            const navsAt2000 = await fund.extrapolateNav(parseEther("2000"));
            expect(navsAt2000.navSum).to.equal(navSum2000);
            expect(navsAt2000.navB).to.equal(navB);
            expect(navsAt2000.navROrZero).to.equal(navR2000);

            const navSum300 = parseEther("0.6")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navR300 = 0;
            const navsAt300 = await fund.extrapolateNav(parseEther("300"));
            expect(navsAt300.navSum).to.equal(navSum300);
            expect(navsAt300.navB).to.equal(navB);
            expect(navsAt300.navROrZero).to.equal(navR300);
        });

        it("Should accrue protocol fee and interest", async function () {
            await pmCreate(user1, parseBtc("1"), parseEther("1"));

            await advanceBlockAtTime(startDay - HOUR * 6);
            const navSum18h = parseEther("3")
                .mul(40000 - DAILY_PROTOCOL_FEE_BPS * 3)
                .div(40000);
            const navB18h = parseEther("1.00075");
            const navR18h = navSum18h.sub(navB18h);
            const navsAt18h = await fund.extrapolateNav(parseEther("1500"));
            expect(navsAt18h.navSum).to.equal(navSum18h);
            expect(navsAt18h.navB).to.equal(navB18h);
            expect(navsAt18h.navROrZero).to.equal(navR18h);

            await advanceBlockAtTime(startDay + DAY * 4);
            const navSum5d = parseEther("3")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS * 5)
                .div(10000);
            const navB5d = parseEther("1.005");
            const navR5d = navSum5d.sub(navB5d);
            const navsAt5d = await fund.extrapolateNav(parseEther("1500"));
            expect(navsAt5d.navSum).to.equal(navSum5d);
            expect(navsAt5d.navB).to.equal(navB5d);
            expect(navsAt5d.navROrZero).to.equal(navR5d);
        });
    });

    // TODO no need fixture
    async function zeroFeeFixture(): Promise<FixtureData> {
        const oldF = await loadFixture(deployFixture);
        const f = { ...oldF };
        await f.twapOracle.mock.getTwap.returns(parseEther("1000"));
        await f.aprOracle.mock.capture.returns(0);

        // Overwrite the fund with a new one with zero protocol fee
        const Fund = await ethers.getContractFactory("FundV3");
        f.fund = await Fund.connect(f.wallets.owner).deploy([
            f.btc.address,
            8,
            f.shareQ.address,
            f.shareB.address,
            f.shareR.address,
            f.primaryMarket.address,
            ethers.constants.AddressZero,
            0, // Zero protocol fee
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            f.twapOracle.address,
            f.aprOracle.address,
            f.interestRateBallot.address,
            f.wallets.feeCollector.address,
        ]);
        await f.fund.initialize(parseEther("500"), parseEther("1"), parseEther("1"));
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
            await pmCreate(user1, parseBtc("1.5"), parseEther("1"));
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navR).to.equal(parseEther("2"));
        });

        it("Should not trigger at exactly lower rebalance threshold", async function () {
            await pmCreate(user1, parseBtc("0.75"), parseEther("1"));
            await advanceOneDayAndSettle();
            expect(await fund.getRebalanceSize()).to.equal(0);
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navR).to.equal(parseEther("0.5"));
        });
    });

    describe("Rebalance", function () {
        let outerFixture: Fixture<FixtureData>;

        // Initial balances
        // User 1: 0.4 Q + 100 B
        // User 2:         200 B + 300 R
        // Total:  0.4 Q + 300 B + 300 R = 1 equivalent Q
        const INIT_Q_1 = parseEther("0.4");
        const INIT_B_1 = parseEther("100");
        const INIT_R_1 = parseEther("0");
        const INIT_Q_2 = parseEther("0");
        const INIT_B_2 = parseEther("200");
        const INIT_R_2 = parseEther("300");
        const INIT_BTC = parseBtc("1");

        async function rebalanceFixture(): Promise<FixtureData> {
            const f = await loadFixture(zeroFeeFixture);
            // Set daily interest rate to 10%
            await f.aprOracle.mock.capture.returns(parseEther("0.1"));
            await advanceBlockAtTime(f.startDay);
            await f.fund.settle();
            const addr1 = f.wallets.user1.address;
            const addr2 = f.wallets.user2.address;
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_Q, addr1, INIT_Q_1, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_B, addr1, INIT_B_1, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_R, addr1, INIT_R_1, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_Q, addr2, INIT_Q_2, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_B, addr2, INIT_B_2, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_R, addr2, INIT_R_2, 0);
            await f.btc.mint(f.fund.address, INIT_BTC);
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

        // Trigger a new rebalance with the given price change
        async function mockRebalance(priceChange: BigNumber) {
            const lastPrice = await twapOracle.getTwap(0);
            const newPrice = lastPrice.mul(priceChange).div(parseEther("1"));
            await twapOracle.mock.getTwap.returns(newPrice);
            await advanceOneDayAndSettle();
        }

        // NAV before rebalance: (1.1, 2.9)
        // 1 B => 0.00005 Q' + 1 B'
        // 1 R => 0.00095 Q'        + 1 R'
        const preDefinedRebalance200 = () => mockRebalance(parseEther("2"));

        // NAV before rebalance: (1.1, 3.9)
        // 1 B => 0.00004 Q' + 1 B'
        // 1 R => 0.00116 Q'        + 1 R'
        const preDefinedRebalance250 = () => mockRebalance(parseEther("2.5"));

        // NAV before rebalance: (1.1, 0.5)
        // 1 B => 0.00075 Q' + 0.5 B'
        // 1 R =>                     + 0.5 R'
        const preDefinedRebalance080 = () => mockRebalance(parseEther("0.8"));

        // NAV before rebalance: (1.1, -0.3)
        // 1 B => 0.002 Q'
        // 1 R => 0
        const preDefinedRebalance040 = () => mockRebalance(parseEther("0.4"));

        describe("Rebalance matrix", function () {
            it("Upper rebalance", async function () {
                await preDefinedRebalance200();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs((await fund.currentDay()) - DAY);
                expect(navs.navB).to.equal(parseEther("1"));
                expect(navs.navR).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioB2Q).to.equal(parseEther("0.00005"));
                expect(rebalance.ratioR2Q).to.equal(parseEther("0.00095"));
                expect(rebalance.ratioBR).to.equal(parseEther("1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(parseEther("0.405"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(parseEther("100"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(parseEther("0.295"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("200"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(parseEther("300"));
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(parseEther("0.7"));
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(parseEther("300"));
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(parseEther("300"));
                expect(await fund.splitRatio()).to.equal(parseEther("1000"));
                expect(await fund.getEquivalentTotalQ()).to.equal(parseEther("1"));
                expect(await fund.getEquivalentTotalB()).to.equal(parseEther("1000"));
            });

            it("Lower rebalance", async function () {
                await preDefinedRebalance080();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs((await fund.currentDay()) - DAY);
                expect(navs.navB).to.equal(parseEther("1"));
                expect(navs.navR).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioB2Q).to.equal(parseEther("0.00075"));
                expect(rebalance.ratioR2Q).to.equal(0);
                expect(rebalance.ratioBR).to.equal(parseEther("0.5"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(parseEther("0.475"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(parseEther("50"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(parseEther("0.15"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("100"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(parseEther("150"));
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(parseEther("0.625"));
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(parseEther("150"));
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(parseEther("150"));
                expect(await fund.splitRatio()).to.equal(parseEther("400"));
                expect(await fund.getEquivalentTotalQ()).to.equal(parseEther("1"));
                expect(await fund.getEquivalentTotalB()).to.equal(parseEther("400"));
            });

            it("Lower rebalance with negative ROOK NAV", async function () {
                await preDefinedRebalance040();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs((await fund.currentDay()) - DAY);
                expect(navs.navB).to.equal(parseEther("1"));
                expect(navs.navR).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioB2Q).to.equal(parseEther("0.002"));
                expect(rebalance.ratioR2Q).to.equal(0);
                expect(rebalance.ratioBR).to.equal(0);
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(parseEther("0.6"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(parseEther("0.4"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(0);
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(parseEther("1"));
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(0);
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(0);
                expect(await fund.splitRatio()).to.equal(parseEther("200"));
                expect(await fund.getEquivalentTotalQ()).to.equal(parseEther("1"));
                expect(await fund.getEquivalentTotalB()).to.equal(parseEther("200"));
            });
        });

        describe("doRebalance()", function () {
            it("Should use rebalance at the specified index", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                await preDefinedRebalance200(); // This one is selected
                const splitRatio = parseEther("2000");
                expect(await fund.splitRatio()).to.equal(splitRatio);
                await preDefinedRebalance040();
                const [q, b, r] = await fund.doRebalance(
                    parseEther("10000"),
                    parseEther("100"),
                    parseEther("1"),
                    2
                );
                const qFromB = parseEther("10").mul(parseEther("1")).div(splitRatio).div(2);
                const qFromR = parseEther("1.9").mul(parseEther("1")).div(splitRatio).div(2);
                expect(q).to.equal(parseEther("10000").add(qFromB).add(qFromR));
                expect(b).to.equal(parseEther("100"));
                expect(r).to.equal(parseEther("1"));
            });

            it("Should round down the result", async function () {
                await preDefinedRebalance200();
                expect((await fund.doRebalance(0, 50000, 0, 0))[0]).to.equal(2);
                expect((await fund.doRebalance(0, 0, 50000, 0))[0]).to.equal(47);
                // Precise value is 2.5 + 47.5 = 50.0
                expect((await fund.doRebalance(0, 50000, 50000, 0))[0]).to.equal(49);
            });
        });

        describe("batchRebalance()", function () {
            it("Should use rebalance at the specified index range", async function () {
                await preDefinedRebalance040();
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                await preDefinedRebalance200();
                const [q, b, r] = await fund.batchRebalance(
                    parseEther("1000"),
                    parseEther("1000"),
                    parseEther("1000"),
                    1,
                    4
                );
                // Before rebalance: 1000 + 1000 / splitRatio(200) = 1005 equivalent Q
                // After rebalance: 1004.375 + 500 / splitRatio(800) = 1005 equivalent Q
                expect(q).to.equal(parseEther("1004.375"));
                expect(b).to.equal(parseEther("500"));
                expect(r).to.equal(parseEther("500"));
            });
        });

        describe("getRebalance()", function () {
            it("Should return the rebalance struct at the given index", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance040();
                await preDefinedRebalance200();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                const splitRatio = parseEther("320");
                expect(await fund.splitRatio()).to.equal(splitRatio);
                await preDefinedRebalance250();
                const rebalance = await fund.getRebalance(2);
                expect(rebalance.ratioB2Q).to.equal(
                    parseEther("0.1").mul(parseEther("1")).div(splitRatio).div(2)
                );
                expect(rebalance.ratioR2Q).to.equal(
                    parseEther("1.9").mul(parseEther("1")).div(splitRatio).div(2)
                );
                expect(rebalance.ratioBR).to.equal(parseEther("1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
            });

            it("Should return zeros if the given index is out of bound", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance040();
                await preDefinedRebalance200();
                await preDefinedRebalance250();
                const rebalance = await fund.getRebalance(4);
                expect(rebalance.ratioB2Q).to.equal(0);
                expect(rebalance.ratioR2Q).to.equal(0);
                expect(rebalance.ratioBR).to.equal(0);
                expect(rebalance.timestamp).to.equal(0);
            });
        });

        describe("getRebalanceTimestamp()", function () {
            it("Should return the trading day of a given rebalance", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance040();
                await preDefinedRebalance200();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                await preDefinedRebalance250();
                expect(await fund.getRebalanceTimestamp(2)).to.equal(settlementTimestamp);
            });

            it("Should return zero if the given index is out of bound", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance040();
                await preDefinedRebalance200();
                await preDefinedRebalance250();
                expect(await fund.getRebalanceTimestamp(4)).to.equal(0);
            });
        });

        describe("Balance refresh on interaction", function () {
            it("No refresh when rebalance is triggered", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(0);
                expect(await fund.trancheBalanceVersion(addr2)).to.equal(0);
            });

            it("transfer()", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                const oldB1 = await fund.trancheBalanceOf(TRANCHE_B, addr1);
                const oldR2 = await fund.trancheBalanceOf(TRANCHE_R, addr2);
                await advanceOneDayAndSettle();
                await shareQ.call(fund, "shareTransfer", addr1, addr2, 1);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(2);
                expect(await fund.trancheBalanceVersion(addr2)).to.equal(2);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB1);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(oldR2);
            });

            it("primaryMarketMint()", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                const oldB = await fund.trancheBalanceOf(TRANCHE_B, addr1);
                await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_Q, addr1, 1, 2);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(2);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
            });

            it("primaryMarketBurn()", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                const oldR = await fund.trancheBalanceOf(TRANCHE_R, addr2);
                await primaryMarket.call(fund, "primaryMarketBurn", TRANCHE_B, addr2, 1, 2);
                expect(await fund.trancheBalanceVersion(addr2)).to.equal(2);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(oldR);
            });
        });

        describe("refreshBalance()", function () {
            it("Non-zero targetVersion", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                await preDefinedRebalance200();
                await preDefinedRebalance040();
                await preDefinedRebalance080();
                const oldQ = await fund.trancheBalanceOf(TRANCHE_Q, addr1);
                const oldB = await fund.trancheBalanceOf(TRANCHE_B, addr1);
                const oldR = await fund.trancheBalanceOf(TRANCHE_R, addr1);
                await fund.refreshBalance(addr1, 2);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(2);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(oldQ);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(oldR);
                await fund.refreshBalance(addr1, 5);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(5);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(oldQ);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(oldR);
            });

            it("Zero targetVersion", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                await preDefinedRebalance200();
                const oldQ = await fund.trancheBalanceOf(TRANCHE_Q, addr1);
                const oldB = await fund.trancheBalanceOf(TRANCHE_B, addr1);
                const oldR = await fund.trancheBalanceOf(TRANCHE_R, addr1);
                await fund.refreshBalance(addr1, 0);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(3);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(oldQ);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(oldR);
            });

            it("Should make no change if targetVersion is older", async function () {
                await preDefinedRebalance080();
                await preDefinedRebalance250();
                await preDefinedRebalance200();
                const oldQ = await fund.trancheBalanceOf(TRANCHE_Q, addr1);
                const oldB = await fund.trancheBalanceOf(TRANCHE_B, addr1);
                const oldR = await fund.trancheBalanceOf(TRANCHE_R, addr1);
                await fund.refreshBalance(addr1, 3);
                await fund.refreshBalance(addr1, 1);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(3);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(oldQ);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(oldR);
            });
        });
    });

    describe("Settlement with strategy", function () {
        const DAILY_PROTOCOL_FEE_BPS = 1; // 0.01% per day TODO
        const navB = parseEther("1.001");

        beforeEach(async function () {
            await fund
                .connect(owner)
                .updateDailyProtocolFeeRate(parseEther("0.0001").mul(DAILY_PROTOCOL_FEE_BPS));
            await twapOracle.mock.getTwap.returns(parseEther("1000"));
            // Change strategy
            await fund.connect(owner).proposeStrategyUpdate(strategy.address);
            await advanceBlockAtTime(startTimestamp + HOUR + ROLE_UPDATE_MIN_DELAY + 10);
            await fund.connect(owner).applyStrategyUpdate(strategy.address);
            await btc.connect(strategy).approve(fund.address, BigNumber.from("2").pow(256).sub(1));
            // Settle days before the strategy change
            for (let i = 0; i < ROLE_UPDATE_MIN_DELAY / DAY; i++) {
                await fund.settle();
            }
            startDay += ROLE_UPDATE_MIN_DELAY;
            // Create 10 QUEEN with 10 BTC on the first day.
            await pmCreate(user1, parseBtc("10"), parseEther("10"));
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

        it("Should cumulate redemption debt", async function () {
            await advanceBlockAtTime(startDay + DAY);
            await primaryMarket.call(
                fund,
                "primaryMarketAddDebt",
                parseBtc("0.1"),
                parseBtc("0.01")
            );
            await fund.settle(); // protocol fee is paid, redemption debt is cumulated
            await primaryMarket.call(
                fund,
                "primaryMarketAddDebt",
                parseBtc("0.2"),
                parseBtc("0.02")
            );
            await fund.settle(); // protocol fee is paid, redemption debt is cumulated
            expect(await fund.feeDebt()).to.equal(0);
            expect(await fund.redemptionDebt()).to.equal(parseBtc("0.3"));
            expect(await fund.getTotalDebt()).to.equal(parseBtc("0.3"));
        });

        it("Should pay fee debt if there is enough balance in fund", async function () {
            await fund.connect(strategy).transferToStrategy(parseBtc("0.9"));
            await primaryMarket.call(fund, "primaryMarketAddDebt", 0, parseBtc("0.3"));
            await advanceBlockAtTime(startDay);
            await expect(() => fund.settle()).to.changeTokenBalances(
                btc,
                [feeCollector, fund],
                [parseBtc("0.1"), parseBtc("-0.1")]
            );
            const fee = parseBtc("9.7").mul(DAILY_PROTOCOL_FEE_BPS).div(10000).add(parseBtc("0.3"));
            expect(await fund.feeDebt()).to.equal(fee.sub(parseBtc("0.1")));
            expect(await fund.getTotalDebt()).to.equal(fee.sub(parseBtc("0.1")));
        });

        it("Should pay fee debt on transfer from strategy", async function () {
            await fund.connect(strategy).transferToStrategy(parseBtc("1"));
            await primaryMarket.call(
                fund,
                "primaryMarketAddDebt",
                parseBtc("0.3"),
                parseBtc("0.1")
            );
            await advanceBlockAtTime(startDay);
            await fund.settle();
            const fee = parseBtc("9.6").mul(DAILY_PROTOCOL_FEE_BPS).div(10000).add(parseBtc("0.1"));
            expect(await fund.feeDebt()).to.equal(fee);

            await fund.connect(strategy).transferFromStrategy(fee.div(10));
            expect(await fund.feeDebt()).to.equal(fee.sub(fee.div(10)));
            expect(await fund.redemptionDebt()).to.equal(parseBtc("0.3"));
            await fund.connect(strategy).transferFromStrategy(parseBtc("2"));
            expect(await fund.feeDebt()).to.equal(0);
            expect(await fund.redemptionDebt()).to.equal(parseBtc("0.3"));
            expect(await fund.getTotalDebt()).to.equal(parseBtc("0.3"));
        });

        it("Should reject strategy change with debt", async function () {
            await fund.connect(strategy).transferToStrategy(parseBtc("1"));
            await primaryMarket.call(fund, "primaryMarketAddDebt", 0, parseBtc("0.1"));
            await advanceBlockAtTime(startDay);
            await fund.settle();
            await fund.connect(owner).proposeStrategyUpdate(addr1);
            await advanceBlockAtTime(startDay + ROLE_UPDATE_MIN_DELAY + DAY / 2);
            await expect(fund.connect(owner).applyStrategyUpdate(addr1)).to.be.revertedWith(
                "Cannot update strategy with debt"
            );
        });

        it("Should update NAV according to profit", async function () {
            // Profit is 5% of the total underlying at the last settlement
            await fund.connect(strategy).reportProfit(parseBtc("1"), parseBtc("0.5"));
            const navSum = parseEther("2.1")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navR = navSum.sub(navB);
            await advanceBlockAtTime(startDay);
            await fund.settle();
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navB).to.equal(navB);
            expect(navs.navR).to.equal(navR);
        });

        it("Should update NAV according to loss", async function () {
            // Loss is 10% of the total underlying at the last settlement
            await fund.connect(strategy).reportLoss(parseBtc("1"));
            const navSum = parseEther("1.8")
                .mul(10000 - DAILY_PROTOCOL_FEE_BPS)
                .div(10000);
            const navR = navSum.sub(navB);
            await advanceBlockAtTime(startDay);
            await fund.settle();
            const navs = await fund.historicalNavs(startDay);
            expect(navs.navB).to.equal(navB);
            expect(navs.navR).to.equal(navR);
        });
    });
});
