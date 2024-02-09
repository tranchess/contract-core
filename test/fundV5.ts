import { expect } from "chai";
import { BigNumber, BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
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

const WEIGHT_B = 9;
const SETTLEMENT_PERIOD = DAY * 100;
const INTEREST_RATE = parseEther("0.001"); // daily 0.1%
const INITIAL_WST_RATE = parseEther("4");
const INITIAL_SPLIT_RATIO = INITIAL_WST_RATE.div(WEIGHT_B + 1);

const POST_REBALANCE_DELAY_TIME = HOUR / 2;
const ROLE_UPDATE_MIN_DELAY = DAY * 3;
const ROLE_UPDATE_MAX_DELAY = DAY * 15;

describe("FundV5", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startDay: number;
        readonly startTimestamp: number;
        readonly twapOracle: Contract;
        readonly wstETH: Contract;
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
    let twapOracle: Contract;
    let wstETH: Contract;
    let shareQ: MockContract;
    let shareB: MockContract;
    let shareR: MockContract;
    let primaryMarket: MockContract;
    let fund: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner, feeCollector, strategy] = provider.getWallets();

        let startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startDay = Math.ceil(startTimestamp / DAY + 1) * DAY + SETTLEMENT_TIME;
        // The test cases starts at 2:00
        startTimestamp = startDay + 3600 * 12;
        await advanceBlockAtTime(startTimestamp);

        const MockToken = await ethers.getContractFactory("MockToken");
        const stETH = await MockToken.connect(owner).deploy("Mock stETH", "stETH", 18);
        const MockWstETH = await ethers.getContractFactory("MockWstETH");
        const wstETH = await MockWstETH.connect(owner).deploy(stETH.address);
        await stETH.mint(wstETH.address, parseEther("1000000"));
        await wstETH.update(INITIAL_WST_RATE);

        for (const user of [user1, user2]) {
            await stETH.mint(user.address, parseEther("2000"));
            await stETH.connect(user).approve(wstETH.address, parseEther("2000"));
            await wstETH.connect(user).wrap(parseEther("1000"));
        }

        const WstETHPriceOracle = await ethers.getContractFactory("WstETHPriceOracle");
        const twapOracle = await WstETHPriceOracle.deploy(wstETH.address);

        const ConstAprOracle = await ethers.getContractFactory("ConstAprOracle");
        const aprOracle = await ConstAprOracle.deploy(INTEREST_RATE); // daily 0.01%

        const shareQ = await deployMockForName(owner, "IShareV2");
        const shareB = await deployMockForName(owner, "IShareV2");
        const shareR = await deployMockForName(owner, "IShareV2");
        for (const share of [shareQ, shareB, shareR]) {
            await share.mock.fundEmitTransfer.returns();
            await share.mock.fundEmitApproval.returns();
        }
        const primaryMarket = await deployMockForName(owner, "IPrimaryMarketV5");
        await primaryMarket.mock.settle.returns();

        const Fund = await ethers.getContractFactory("FundV5");
        const fund = await Fund.connect(owner).deploy([
            WEIGHT_B,
            SETTLEMENT_PERIOD,
            wstETH.address,
            18,
            shareQ.address,
            shareB.address,
            shareR.address,
            primaryMarket.address,
            ethers.constants.AddressZero,
            twapOracle.address,
            aprOracle.address,
            feeCollector.address,
        ]);
        await fund.initialize(INITIAL_SPLIT_RATIO, parseEther("1"), parseEther("1"), 0);

        return {
            wallets: { user1, user2, owner, feeCollector, strategy },
            startDay,
            startTimestamp,
            twapOracle,
            wstETH,
            shareQ,
            shareB,
            shareR,
            primaryMarket,
            fund: fund.connect(user1),
        };
    }

    async function advanceAndSettle() {
        await advanceBlockAtTime((await fund.currentDay()).toNumber());
        await fund.settle();
    }

    async function pmCreate(
        user: Wallet,
        inWstETH: BigNumberish,
        outQ: BigNumberish,
        version?: number
    ): Promise<void> {
        await wstETH.connect(user).transfer(fund.address, inWstETH);
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
        wstETH = fixtureData.wstETH;
        shareQ = fixtureData.shareQ;
        shareB = fixtureData.shareB;
        shareR = fixtureData.shareR;
        primaryMarket = fixtureData.primaryMarket;
        fund = fixtureData.fund;
    });

    describe("endOfDay()", function () {
        it("Should return the next day", async function () {
            expect(await fund.endOfDay(startTimestamp)).to.equal(startDay + DAY);
            expect(await fund.endOfDay(startTimestamp + DAY * 10)).to.equal(startDay + DAY * 11);
        });

        it("Should return the next day if given a settlement timestamp", async function () {
            expect(await fund.endOfDay(startDay)).to.equal(startDay + DAY);
            expect(await fund.endOfDay(startDay + DAY * 10)).to.equal(startDay + DAY * 11);
        });
    });

    describe("isFundActive()", function () {
        it("Should transfer Q when inactive", async function () {
            await pmCreate(user1, parseEther("1"), parseEther("1"));
            await advanceAndSettle();

            expect(await fund.isFundActive(startDay + POST_REBALANCE_DELAY_TIME - 1)).to.equal(
                false
            );
            await shareQ.call(fund, "shareTransfer", addr1, addr2, 0);
        });

        it("Should transfer B/R reverts when inactive", async function () {
            await pmCreate(user1, parseEther("1"), parseEther("1"));
            await advanceAndSettle();

            expect(await fund.isFundActive(startDay + POST_REBALANCE_DELAY_TIME - 1)).to.equal(
                false
            );
            await expect(shareB.call(fund, "shareTransfer", addr1, addr2, 0)).to.be.revertedWith(
                "Transfer is inactive"
            );
            await expect(shareR.call(fund, "shareTransfer", addr1, addr2, 0)).to.be.revertedWith(
                "Transfer is inactive"
            );
        });

        it("Should return the activity window with rebalance", async function () {
            await pmCreate(user1, parseEther("1"), parseEther("1"));
            await advanceAndSettle();

            expect(await fund.fundActivityStartTime()).to.equal(
                startDay + SETTLEMENT_PERIOD + POST_REBALANCE_DELAY_TIME
            );
            expect(await fund.currentDay()).to.equal(startDay + SETTLEMENT_PERIOD * 2);
            expect(
                await fund.isFundActive(
                    startDay + SETTLEMENT_PERIOD + POST_REBALANCE_DELAY_TIME - 1
                )
            ).to.equal(false);
            expect(
                await fund.isFundActive(startDay + SETTLEMENT_PERIOD + POST_REBALANCE_DELAY_TIME)
            ).to.equal(true);
        });
    });

    describe("FundRoles", function () {
        describe("Primary market and strategy", function () {
            let newPm: MockContract;

            beforeEach(async function () {
                newPm = await deployMockForName(owner, "IPrimaryMarketV5");
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
                const primaryMarketProposal = await fund.primaryMarketUpdateProposal();
                expect(primaryMarketProposal[0]).to.equal(newPm.address);
                expect(primaryMarketProposal[1]).to.equal(
                    (await ethers.provider.getBlock("latest")).timestamp
                );
                await fund.connect(owner).proposeStrategyUpdate(strategy.address);
                const strategyProposal = await fund.strategyUpdateProposal();
                expect(strategyProposal[0]).to.equal(strategy.address);
                expect(strategyProposal[1]).to.equal(
                    (await ethers.provider.getBlock("latest")).timestamp
                );
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
                await primaryMarket.call(fund, "primaryMarketAddDebtAndFee", 1, 0);
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
                const primaryMarketProposal = await fund.primaryMarketUpdateProposal();
                expect(primaryMarketProposal[0]).to.equal(ethers.constants.AddressZero);
                expect(primaryMarketProposal[1]).to.equal(0);
                expect(await fund.strategy()).to.equal(strategy.address);
                const strategyProposal = await fund.strategyUpdateProposal();
                expect(strategyProposal[0]).to.equal(ethers.constants.AddressZero);
                expect(strategyProposal[1]).to.equal(0);
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

    describe("Share balance management", function () {
        let fundFromShares: { fundFromShare: Contract; tranche: number }[];

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
                "The current trading year does not end yet"
            );
            await advanceBlockAtTime(startDay + SETTLEMENT_PERIOD - 30);
            await expect(fund.settle()).to.be.revertedWith(
                "The current trading year does not end yet"
            );
        });
    });

    describe("extrapolateNav()", function () {
        const wstETHInFund = parseEther("10");
        const equivalentTotalR = wstETHInFund.mul(INITIAL_SPLIT_RATIO).div(parseEther("1"));

        it("Should return the previous settlement if fund is empty", async function () {
            await advanceBlockAtTime(startDay + DAY * 10);
            const startNavs = await fund.extrapolateNav(parseEther("1.5"));
            expect(startNavs.navSum).to.equal(parseEther("1").mul(WEIGHT_B + 1));
            expect(startNavs.navB).to.equal(parseEther("1"));
            expect(startNavs.navROrZero).to.equal(parseEther("1"));
        });

        it("Should use the price", async function () {
            await pmCreate(user1, parseEther("10"), parseEther("10"));
            await advanceBlockAtTime(startDay + DAY * 10);
            const navB = parseEther("1").add(INTEREST_RATE.mul(10));

            const navSum5 = parseEther("5").mul(wstETHInFund).div(equivalentTotalR);
            const navR5 = navSum5.sub(navB.mul(WEIGHT_B));
            const navsAt5 = await fund.extrapolateNav(parseEther("5"));
            expect(navsAt5.navSum).to.equal(navSum5);
            expect(navsAt5.navB).to.equal(navB);
            expect(navsAt5.navROrZero).to.equal(navR5);

            const navSum8 = parseEther("8").mul(wstETHInFund).div(equivalentTotalR);
            const navR8 = navSum8.sub(navB.mul(WEIGHT_B));
            const navsAt8 = await fund.extrapolateNav(parseEther("8"));
            expect(navsAt8.navSum).to.equal(navSum8);
            expect(navsAt8.navB).to.equal(navB);
            expect(navsAt8.navROrZero).to.equal(navR8);

            const navSum3 = parseEther("3").mul(wstETHInFund).div(equivalentTotalR);
            const navR3 = 0;
            const navsAt3 = await fund.extrapolateNav(parseEther("3"));
            expect(navsAt3.navSum).to.equal(navSum3);
            expect(navsAt3.navB).to.equal(navB);
            expect(navsAt3.navROrZero).to.equal(navR3);
        });
    });

    describe("Rebalance", function () {
        let outerFixture: Fixture<FixtureData>;

        // Initial balances
        // User 1: 4 Q +  1.6 B
        // User 2:       20   B + 2.4 R
        // Total:  4 Q + 21.6 B + 2.4 R = 10 equivalent Q
        const INIT_Q_1 = parseEther("4");
        const INIT_B_1 = parseEther("1.6");
        const INIT_R_1 = parseEther("0");
        const INIT_Q_2 = parseEther("0");
        const INIT_B_2 = parseEther("20");
        const INIT_R_2 = parseEther("2.4");
        const INIT_WST_ETH = parseEther("10");

        async function rebalanceFixture(): Promise<FixtureData> {
            const f = await loadFixture(deployFixture);
            const addr1 = f.wallets.user1.address;
            const addr2 = f.wallets.user2.address;
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_Q, addr1, INIT_Q_1, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_B, addr1, INIT_B_1, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_R, addr1, INIT_R_1, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_Q, addr2, INIT_Q_2, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_B, addr2, INIT_B_2, 0);
            await f.primaryMarket.call(f.fund, "primaryMarketMint", TRANCHE_R, addr2, INIT_R_2, 0);
            await f.wstETH.connect(f.wallets.user1).transfer(f.fund.address, INIT_WST_ETH);
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
        async function mockRebalance(wstRateChange: BigNumber) {
            const lastRate = await twapOracle.getLatest();
            const newRate = lastRate.mul(wstRateChange).div(parseEther("1"));
            await wstETH.update(newRate);
            await advanceAndSettle();
        }

        // NAV before rebalance: (1.1, 1.1)
        // 1 B => 1.1 B'
        // 1 R => 1.1 R'
        const preDefinedRebalance110 = () => mockRebalance(parseEther("1.1"));

        // NAV before rebalance: (1.1, 2.6)
        // 1 B => 1.1 B'
        // 1 R => 1.1 R' + q Q'
        // where q = 0.3 if underlying price goes from 4 to 5
        const preDefinedRebalance125 = () => mockRebalance(parseEther("1.25"));

        // NAV before rebalance: (1.1, 10.1)
        // 1 B => 1.1 B'
        // 1 R => 1.1 R' + q Q'
        // where q = 9/8 if underlying price goes from 4 to 8
        const preDefinedRebalance200 = () => mockRebalance(parseEther("2"));

        // NAV before rebalance: (1.1, 0.1)
        // 1 B => 0.1 B' + q Q'
        // 1 R => 0.1 R'
        // where q = 0.25 if underlying price goes from 4 to 4
        const preDefinedRebalance100 = () => mockRebalance(parseEther("1"));

        describe("Rebalance matrix", function () {
            it("Balanced rebalance", async function () {
                await preDefinedRebalance110();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs(startDay + SETTLEMENT_PERIOD);
                expect(navs.navB).to.equal(parseEther("1"));
                expect(navs.navR).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioB2Q).to.equal(0);
                expect(rebalance.ratioR2Q).to.equal(0);
                expect(rebalance.ratioBR).to.equal(parseEther("1.1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(parseEther("4"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(parseEther("1.76"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("22"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(parseEther("2.64"));
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(parseEther("4"));
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(parseEther("23.76"));
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(parseEther("2.64"));
                expect(await fund.splitRatio()).to.equal(parseEther("0.44"));
                expect(await fund.getEquivalentTotalQ()).to.equal(parseEther("10"));
                expect(await fund.getEquivalentTotalR()).to.equal(parseEther("4.4"));
                expect(await fund.getEquivalentTotalB()).to.equal(parseEther("39.6"));
            });

            it("Upper rebalance", async function () {
                await preDefinedRebalance125();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs(startDay + SETTLEMENT_PERIOD);
                expect(navs.navB).to.equal(parseEther("1"));
                expect(navs.navR).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioB2Q).to.equal(0);
                expect(rebalance.ratioR2Q).to.equal(parseEther("0.3"));
                expect(rebalance.ratioBR).to.equal(parseEther("1.1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(parseEther("4"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(parseEther("1.76"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(parseEther("0.72"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("22"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(parseEther("2.64"));
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(parseEther("4.72"));
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(parseEther("23.76"));
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(parseEther("2.64"));
                expect(await fund.splitRatio()).to.equal(parseEther("0.5"));
                expect(await fund.getEquivalentTotalQ()).to.equal(parseEther("10"));
                expect(await fund.getEquivalentTotalR()).to.equal(parseEther("5"));
                expect(await fund.getEquivalentTotalB()).to.equal(parseEther("45"));
            });

            it("Lower rebalance", async function () {
                await preDefinedRebalance100();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                expect(await fund.getRebalanceSize()).to.equal(1);
                const navs = await fund.historicalNavs(startDay + SETTLEMENT_PERIOD);
                expect(navs.navB).to.equal(parseEther("1"));
                expect(navs.navR).to.equal(parseEther("1"));
                const rebalance = await fund.getRebalance(0);
                expect(rebalance.ratioB2Q).to.equal(parseEther("0.25"));
                expect(rebalance.ratioR2Q).to.equal(0);
                expect(rebalance.ratioBR).to.equal(parseEther("0.1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(parseEther("4.4"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(parseEther("0.16"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
                expect(await fund.trancheBalanceOf(TRANCHE_Q, addr2)).to.equal(parseEther("5"));
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr2)).to.equal(parseEther("2"));
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(parseEther("0.24"));
                expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(parseEther("9.4"));
                expect(await fund.trancheTotalSupply(TRANCHE_B)).to.equal(parseEther("2.16"));
                expect(await fund.trancheTotalSupply(TRANCHE_R)).to.equal(parseEther("0.24"));
                expect(await fund.splitRatio()).to.equal(parseEther("0.4"));
                expect(await fund.getEquivalentTotalQ()).to.equal(parseEther("10"));
                expect(await fund.getEquivalentTotalR()).to.equal(parseEther("4"));
                expect(await fund.getEquivalentTotalB()).to.equal(parseEther("36"));
            });

            it("Failed rebalance with negative ROOK NAV", async function () {
                const lastRate = await twapOracle.getLatest();
                const newRate = lastRate.mul(WEIGHT_B).div(WEIGHT_B + 1);
                await wstETH.update(newRate);
                await advanceBlockAtTime((await fund.currentDay()).toNumber());
                await expect(fund.settle()).to.be.revertedWith("To be frozen");
            });
        });

        describe("doRebalance()", function () {
            it("Should use rebalance at the specified index", async function () {
                await preDefinedRebalance125();
                await preDefinedRebalance200();
                await preDefinedRebalance100(); // This one is selected
                const splitRatio = parseEther("1"); // 0.4 * 1.25 * 2 * 1
                expect(await fund.splitRatio()).to.equal(splitRatio);
                await preDefinedRebalance110();
                const [q, b, r] = await fund.doRebalance(
                    parseEther("10000"),
                    parseEther("100"),
                    parseEther("1"),
                    2
                );
                const qFromB = parseEther("100")
                    .mul(parseEther("1"))
                    .div(splitRatio)
                    .div(WEIGHT_B + 1);
                expect(q).to.equal(parseEther("10000").add(qFromB));
                expect(b).to.equal(parseEther("10"));
                expect(r).to.equal(parseEther("0.1"));
            });

            it("Should round down the result", async function () {
                await preDefinedRebalance200();
                // Precise value is 10 * 9/8 = 11.25
                expect((await fund.doRebalance(0, 0, 10, 0))[0]).to.equal(11);
            });
        });

        describe("batchRebalance()", function () {
            it("Should use rebalance at the specified index range", async function () {
                await preDefinedRebalance125(); // price: 5
                await preDefinedRebalance200(); // price: 10
                await preDefinedRebalance100(); // price: 10
                await preDefinedRebalance110(); // price: 11
                const [q, b, r] = await fund.batchRebalance(
                    parseEther("1000"),
                    parseEther("90"),
                    parseEther("10"),
                    1,
                    4
                );
                // Get 9 Q from Rebalance 1
                // Get 9.9 Q from Rebalance 2
                expect(q).to.equal(parseEther("1018.9"));
                expect(b).to.equal(parseEther("10.89"));
                expect(r).to.equal(parseEther("1.21"));
                // Before rebalance: 1000 + 10 / splitRatio(0.5) = 1020 equivalent Q
                // After rebalance: 1018.9 + 1.21 / splitRatio(1.1) = 1020 equivalent Q
            });
        });

        describe("getRebalance()", function () {
            it("Should return the rebalance struct at the given index", async function () {
                await preDefinedRebalance200();
                await preDefinedRebalance100();
                await preDefinedRebalance125(); // This one is selected
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                const splitRatio = parseEther("1"); // 0.4 * 2 * 1 * 1.25 * 2
                expect(await fund.splitRatio()).to.equal(splitRatio);
                await preDefinedRebalance110();
                const rebalance = await fund.getRebalance(2);
                expect(rebalance.ratioB2Q).to.equal(0);
                expect(rebalance.ratioR2Q).to.equal(
                    parseEther("1.5")
                        .mul(parseEther("1"))
                        .div(splitRatio)
                        .div(WEIGHT_B + 1)
                );
                expect(rebalance.ratioBR).to.equal(parseEther("1.1"));
                expect(rebalance.timestamp).to.equal(settlementTimestamp);
            });

            it("Should return zeros if the given index is out of bound", async function () {
                await preDefinedRebalance200();
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                await preDefinedRebalance110();
                const rebalance = await fund.getRebalance(4);
                expect(rebalance.ratioB2Q).to.equal(0);
                expect(rebalance.ratioR2Q).to.equal(0);
                expect(rebalance.ratioBR).to.equal(0);
                expect(rebalance.timestamp).to.equal(0);
            });
        });

        describe("getRebalanceTimestamp()", function () {
            it("Should return the trading day of a given rebalance", async function () {
                await preDefinedRebalance200();
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                const settlementTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
                await preDefinedRebalance110();
                expect(await fund.getRebalanceTimestamp(2)).to.equal(settlementTimestamp);
            });

            it("Should return zero if the given index is out of bound", async function () {
                await preDefinedRebalance200();
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                await preDefinedRebalance110();
                expect(await fund.getRebalanceTimestamp(4)).to.equal(0);
            });
        });

        describe("Balance refresh on interaction", function () {
            it("No refresh when rebalance is triggered", async function () {
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(0);
                expect(await fund.trancheBalanceVersion(addr2)).to.equal(0);
            });

            it("transfer()", async function () {
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                const oldB1 = await fund.trancheBalanceOf(TRANCHE_B, addr1);
                const oldR2 = await fund.trancheBalanceOf(TRANCHE_R, addr2);
                await fund.trancheTransfer(TRANCHE_Q, addr2, 1, 2);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(2);
                expect(await fund.trancheBalanceVersion(addr2)).to.equal(0); // Q receiver not refreshed
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB1);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(oldR2);
                await fund.trancheTransfer(TRANCHE_B, addr2, 1, 2);
                expect(await fund.trancheBalanceVersion(addr2)).to.equal(2);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB1.sub(1));
            });

            it("primaryMarketMint()", async function () {
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                const oldB = await fund.trancheBalanceOf(TRANCHE_B, addr1);
                await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_Q, addr1, 1, 2);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(0); // Q receiver not refreshed
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB);
                await primaryMarket.call(fund, "primaryMarketMint", TRANCHE_B, addr1, 1, 2);
                expect(await fund.trancheBalanceVersion(addr1)).to.equal(2);
                expect(await fund.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(oldB.add(1));
            });

            it("primaryMarketBurn()", async function () {
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                const oldR = await fund.trancheBalanceOf(TRANCHE_R, addr2);
                await primaryMarket.call(fund, "primaryMarketBurn", TRANCHE_B, addr2, 1, 2);
                expect(await fund.trancheBalanceVersion(addr2)).to.equal(2);
                expect(await fund.trancheBalanceOf(TRANCHE_R, addr2)).to.equal(oldR);
            });
        });

        describe("refreshBalance()", function () {
            it("Non-zero targetVersion", async function () {
                await preDefinedRebalance200();
                await preDefinedRebalance100();
                await preDefinedRebalance125();
                await preDefinedRebalance110();
                await preDefinedRebalance200();
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
                await preDefinedRebalance200();
                await preDefinedRebalance100();
                await preDefinedRebalance125();
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
                await preDefinedRebalance200();
                await preDefinedRebalance100();
                await preDefinedRebalance125();
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
        beforeEach(async function () {
            // Change strategy
            await fund.connect(owner).proposeStrategyUpdate(strategy.address);
            await advanceBlockAtTime(startTimestamp + HOUR + ROLE_UPDATE_MIN_DELAY + 10);
            await fund.connect(owner).applyStrategyUpdate(strategy.address);
            await wstETH
                .connect(strategy)
                .approve(fund.address, BigNumber.from("2").pow(256).sub(1));
            // Create 10 QUEEN with 10 wstETH
            await pmCreate(user1, parseEther("10"), parseEther("10"));
            // Transfer 9 BTC to the strategy
            await fund.connect(strategy).transferToStrategy(parseEther("9"));
        });

        it("transferToStrategy()", async function () {
            expect(await fund.getStrategyUnderlying()).to.equal(parseEther("9"));
            expect(await fund.getTotalUnderlying()).to.equal(parseEther("10"));
            await expect(fund.transferToStrategy(parseEther("1"))).to.be.revertedWith(
                "Only strategy"
            );
            await expect(() =>
                fund.connect(strategy).transferToStrategy(parseEther("1"))
            ).to.changeTokenBalances(wstETH, [strategy, fund], [parseEther("1"), parseEther("-1")]);
            expect(await fund.getStrategyUnderlying()).to.equal(parseEther("10"));
            expect(await fund.getTotalUnderlying()).to.equal(parseEther("10"));
        });

        it("transferFromStrategy()", async function () {
            await expect(fund.transferFromStrategy(parseEther("1"))).to.be.revertedWith(
                "Only strategy"
            );
            await expect(() =>
                fund.connect(strategy).transferFromStrategy(parseEther("1"))
            ).to.changeTokenBalances(wstETH, [strategy, fund], [parseEther("-1"), parseEther("1")]);
            expect(await fund.getStrategyUnderlying()).to.equal(parseEther("8"));
            expect(await fund.getTotalUnderlying()).to.equal(parseEther("10"));
        });

        it("reportProfit", async function () {
            await expect(
                fund.reportProfit(parseEther("1"), parseEther("0.1"), 1)
            ).to.be.revertedWith("Only strategy");
            await expect(
                fund.connect(strategy).reportProfit(parseEther("1"), parseEther("2"), 1)
            ).to.be.revertedWith("Fee cannot exceed profit");
            await expect(
                fund
                    .connect(strategy)
                    .reportProfit(parseEther("1"), parseEther("0.1"), parseEther("0.2"))
            ).to.be.revertedWith("Fee cannot exceed profit");
            const totalFeeQ = parseEther("0.1").mul(parseEther("10")).div(parseEther("10.9"));
            const operatorFeeQ = parseEther("0.02").mul(parseEther("10")).div(parseEther("10.9"));
            await expect(
                fund
                    .connect(strategy)
                    .reportProfit(parseEther("1"), parseEther("0.1"), parseEther("0.02"))
            )
                .to.emit(fund, "ProfitReported")
                .withArgs(parseEther("1"), parseEther("0.1"), totalFeeQ, operatorFeeQ);
            expect(await fund.getStrategyUnderlying()).to.equal(parseEther("10"));
            expect(await fund.getTotalUnderlying()).to.equal(parseEther("11"));
            expect(await fund.trancheBalanceOf(TRANCHE_Q, strategy.address)).to.equal(operatorFeeQ);
            expect(await fund.trancheBalanceOf(TRANCHE_Q, feeCollector.address)).to.equal(
                totalFeeQ.sub(operatorFeeQ)
            );
            expect(await fund.trancheTotalSupply(TRANCHE_Q)).to.equal(
                parseEther("10").add(totalFeeQ)
            );
        });

        it("reportLoss", async function () {
            await expect(fund.reportLoss(parseEther("1"))).to.be.revertedWith("Only strategy");
            await expect(fund.connect(strategy).reportLoss(parseEther("1")))
                .to.emit(fund, "LossReported")
                .withArgs(parseEther("1"));
            expect(await fund.getStrategyUnderlying()).to.equal(parseEther("8"));
            expect(await fund.getTotalUnderlying()).to.equal(parseEther("9"));
            expect(await fund.getTotalDebt()).to.equal(0);
        });

        it("Should cumulate redemption debt", async function () {
            await primaryMarket.call(
                fund,
                "primaryMarketAddDebtAndFee",
                parseEther("0.1"),
                parseEther("0.01")
            );
            await wstETH.update(INITIAL_WST_RATE.mul(2));
            await advanceAndSettle(); // redemption debt is cumulated
            await primaryMarket.call(
                fund,
                "primaryMarketAddDebtAndFee",
                parseEther("0.2"),
                parseEther("0.02")
            );
            await wstETH.update(INITIAL_WST_RATE.mul(4));
            await advanceAndSettle(); // redemption debt is cumulated
            expect(await fund.getTotalDebt()).to.equal(parseEther("0.3"));
        });

        it("Should reject strategy change with debt", async function () {
            await fund.connect(strategy).transferToStrategy(parseEther("1"));
            await primaryMarket.call(fund, "primaryMarketAddDebtAndFee", parseEther("0.1"), 0);
            await fund.connect(owner).proposeStrategyUpdate(addr1);
            await advanceBlockAtTime(startDay + ROLE_UPDATE_MIN_DELAY + DAY);
            await expect(fund.connect(owner).applyStrategyUpdate(addr1)).to.be.revertedWith(
                "Cannot update strategy with debt"
            );
        });

        it("Should update NAV according to profit", async function () {
            // Profit is 25% of the total underlying
            await fund
                .connect(strategy)
                .reportProfit(parseEther("6"), parseEther("3.5"), parseEther("0.1"));
            await advanceBlockAtTime(startDay + SETTLEMENT_PERIOD);
            const navSum = parseEther("12.5");
            const navB = parseEther("1").add(INTEREST_RATE.mul(SETTLEMENT_PERIOD / DAY));
            const navR = navSum.sub(navB.mul(WEIGHT_B));
            const navs = await fund.extrapolateNav(INITIAL_WST_RATE);
            expect(navs.navSum).to.equal(navSum);
            expect(navs.navB).to.equal(navB);
            expect(navs.navROrZero).to.equal(navR);

            await fund.settle();
            // The same as `preDefinedRebalance125`.
            const rebalance = await fund.getRebalance(0);
            expect(rebalance.ratioB2Q).to.equal(0);
            expect(rebalance.ratioR2Q).to.equal(parseEther("0.3"));
            expect(rebalance.ratioBR).to.equal(parseEther("1.1"));
        });

        it("Should update NAV according to loss", async function () {
            // Loss is 1% of the total underlying
            await fund.connect(strategy).reportLoss(parseEther("0.1"));
            await advanceBlockAtTime(startDay + DAY * 10);
            const navSum = parseEther("9.9");
            const navB = parseEther("1").add(INTEREST_RATE.mul(10));
            const navR = navSum.sub(navB.mul(WEIGHT_B));
            const navs = await fund.extrapolateNav(INITIAL_WST_RATE);
            expect(navs.navSum).to.equal(navSum);
            expect(navs.navB).to.equal(navB);
            expect(navs.navROrZero).to.equal(navR);

            // Loss is 20% of the total underlying
            await fund.connect(strategy).reportLoss(parseEther("1.9"));
            await wstETH.update(INITIAL_WST_RATE.mul(125).div(100));
            await advanceAndSettle();
            // The same as `preDefinedRebalance100`.
            const rebalance = await fund.getRebalance(0);
            expect(rebalance.ratioB2Q).to.equal(parseEther("0.25"));
            expect(rebalance.ratioR2Q).to.equal(0);
            expect(rebalance.ratioBR).to.equal(parseEther("0.1"));
        });
    });
});
