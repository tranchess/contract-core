import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";

const WEEK = 7 * 86400;
const TRANCHE_M = 0;
const TRANCHE_A = 1;
const TRANCHE_B = 2;
const REWARD_WEIGHT_M = 3;
const REWARD_WEIGHT_A = 4;
const REWARD_WEIGHT_B = 2;
const SETTLEMENT_TIME = 3600 * 14; // UTC time 14:00 every day

// Initial balance:
// User 1: 400 M + 120 A + 180 B
// User 2:         180 A + 120 B
// Reward weight:
// User 1: 400   + 160   + 120   = 680
// User 2:         240   +  80   = 320
// Total : 400   + 400   + 200   = 1000
const USER1_M = parseEther("400");
const USER1_A = parseEther("120");
const USER1_B = parseEther("180");
const USER2_M = parseEther("0");
const USER2_A = parseEther("180");
const USER2_B = parseEther("120");
const TOTAL_M = USER1_M.add(USER2_M);
const TOTAL_A = USER1_A.add(USER2_A);
const TOTAL_B = USER1_B.add(USER2_B);
const USER1_WEIGHT = USER1_M.mul(REWARD_WEIGHT_M)
    .add(USER1_A.mul(REWARD_WEIGHT_A))
    .add(USER1_B.mul(REWARD_WEIGHT_B))
    .div(REWARD_WEIGHT_M);
const USER2_WEIGHT = USER2_M.mul(REWARD_WEIGHT_M)
    .add(USER2_A.mul(REWARD_WEIGHT_A))
    .add(USER2_B.mul(REWARD_WEIGHT_B))
    .div(REWARD_WEIGHT_M);
const TOTAL_WEIGHT = USER1_WEIGHT.add(USER2_WEIGHT);

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

async function setNextBlockTime(time: number) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [time]);
}

/**
 * Note that failed transactions are silently ignored when automining is disabled.
 */
async function setAutomine(flag: boolean) {
    await ethers.provider.send("evm_setAutomine", [flag]);
}

describe("Staking", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly checkpointTimestamp: number;
        readonly nextRateUpdateTime: number;
        readonly fund: MockContract;
        readonly shareM: MockContract;
        readonly shareA: MockContract;
        readonly shareB: MockContract;
        readonly chess: MockContract;
        readonly chessController: MockContract;
        readonly usdc: Contract;
        readonly staking: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let checkpointTimestamp: number;
    let nextRateUpdateTime: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let fund: MockContract;
    let shareM: MockContract;
    let shareA: MockContract;
    let shareB: MockContract;
    let chess: MockContract;
    let chessController: MockContract;
    let usdc: Contract;
    let staking: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        const startEpoch = (await ethers.provider.getBlock("latest")).timestamp;
        advanceBlockAtTime(Math.floor(startEpoch / WEEK) * WEEK + WEEK);
        const endWeek =
            Math.floor((startEpoch + WEEK - SETTLEMENT_TIME) / WEEK) * WEEK +
            SETTLEMENT_TIME +
            WEEK * 2;
        const nextRateUpdateTime = endWeek + WEEK * 10;

        const fund = await deployMockForName(owner, "IFund");
        const shareM = await deployMockForName(owner, "IERC20");
        const shareA = await deployMockForName(owner, "IERC20");
        const shareB = await deployMockForName(owner, "IERC20");
        await fund.mock.tokenM.returns(shareM.address);
        await fund.mock.tokenA.returns(shareA.address);
        await fund.mock.tokenB.returns(shareB.address);
        await fund.mock.getRebalanceSize.returns(0);

        const chess = await deployMockForName(owner, "IChess");
        await chess.mock.getRate.returns(0);

        const chessController = await deployMockForName(owner, "IChessController");
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);

        const Staking = await ethers.getContractFactory("StakingTestWrapper");
        const staking = await Staking.connect(owner).deploy(
            fund.address,
            chess.address,
            chessController.address,
            usdc.address
        );

        // Deposit initial shares
        await shareM.mock.transferFrom.returns(true);
        await shareA.mock.transferFrom.returns(true);
        await shareB.mock.transferFrom.returns(true);
        await staking.connect(user1).deposit(TRANCHE_M, USER1_M);
        await staking.connect(user1).deposit(TRANCHE_A, USER1_A);
        await staking.connect(user1).deposit(TRANCHE_B, USER1_B);
        await staking.connect(user2).deposit(TRANCHE_M, USER2_M);
        await staking.connect(user2).deposit(TRANCHE_A, USER2_A);
        await staking.connect(user2).deposit(TRANCHE_B, USER2_B);
        const checkpointTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        await shareM.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await shareA.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");
        await shareB.mock.transferFrom.revertsWithReason("Mock on the method is not initialized");

        return {
            wallets: { user1, user2, owner },
            checkpointTimestamp,
            nextRateUpdateTime,
            fund,
            shareM,
            shareA,
            shareB,
            chess,
            chessController,
            usdc,
            staking: staking.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        checkpointTimestamp = fixtureData.checkpointTimestamp;
        nextRateUpdateTime = fixtureData.nextRateUpdateTime;
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        addr2 = user2.address;
        fund = fixtureData.fund;
        shareM = fixtureData.shareM;
        shareA = fixtureData.shareA;
        shareB = fixtureData.shareB;
        chess = fixtureData.chess;
        chessController = fixtureData.chessController;
        usdc = fixtureData.usdc;
        staking = fixtureData.staking;
    });

    describe("deposit()", function () {
        it("Should transfer shares and update balance", async function () {
            await expect(() => staking.deposit(TRANCHE_M, 10000)).to.callMocks({
                func: shareM.mock.transferFrom.withArgs(addr1, staking.address, 10000),
                rets: [true],
            });
            expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.add(10000));
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.add(10000));
            await expect(() => staking.deposit(TRANCHE_A, 1000)).to.callMocks({
                func: shareA.mock.transferFrom.withArgs(addr1, staking.address, 1000),
                rets: [true],
            });
            expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.add(1000));
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A.add(1000));
            await expect(() => staking.deposit(TRANCHE_B, 100)).to.callMocks({
                func: shareB.mock.transferFrom.withArgs(addr1, staking.address, 100),
                rets: [true],
            });
            expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.add(100));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.add(100));
        });

        it("Should emit an event", async function () {
            await shareM.mock.transferFrom.returns(true);
            await expect(staking.deposit(TRANCHE_M, 10000))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_M, addr1, 10000);
            await shareA.mock.transferFrom.returns(true);
            await expect(staking.deposit(TRANCHE_A, 1000))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_A, addr1, 1000);
            await shareB.mock.transferFrom.returns(true);
            await expect(staking.deposit(TRANCHE_B, 100))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_B, addr1, 100);
        });
    });

    describe("claimAndDeposit()", function () {
        it("Should transfer shares and update balance", async function () {
            const primaryMarket = await deployMockForName(owner, "IPrimaryMarket");
            await expect(() => staking.claimAndDeposit(primaryMarket.address)).to.callMocks(
                {
                    func: primaryMarket.mock.claim.withArgs(addr1),
                    rets: [10000, 0],
                },
                {
                    func: shareM.mock.transferFrom.withArgs(addr1, staking.address, 10000),
                    rets: [true],
                }
            );
            expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.add(10000));
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.add(10000));
        });

        it("Should emit an event", async function () {
            const primaryMarket = await deployMockForName(owner, "IPrimaryMarket");
            await primaryMarket.mock.claim.withArgs(addr1).returns(10000, 0);
            await shareM.mock.transferFrom.withArgs(addr1, staking.address, 10000).returns(true);
            await expect(staking.claimAndDeposit(primaryMarket.address))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_M, addr1, 10000);
        });
    });

    describe("withdraw()", function () {
        it("Should transfer shares and update balance", async function () {
            await expect(() => staking.withdraw(TRANCHE_M, 1000)).to.callMocks({
                func: shareM.mock.transfer.withArgs(addr1, 1000),
                rets: [true],
            });
            expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.sub(1000));
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.sub(1000));
            await expect(() => staking.withdraw(TRANCHE_A, 100)).to.callMocks({
                func: shareA.mock.transfer.withArgs(addr1, 100),
                rets: [true],
            });
            expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.sub(100));
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A.sub(100));
            await expect(() => staking.withdraw(TRANCHE_B, 10)).to.callMocks({
                func: shareB.mock.transfer.withArgs(addr1, 10),
                rets: [true],
            });
            expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.sub(10));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.sub(10));
        });

        it("Should revert if balance is not enough", async function () {
            await expect(staking.withdraw(TRANCHE_M, USER1_M.add(1))).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
            await expect(staking.withdraw(TRANCHE_A, USER1_A.add(1))).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
            await expect(staking.withdraw(TRANCHE_B, USER1_B.add(1))).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
        });

        it("Should emit an event", async function () {
            await shareM.mock.transfer.returns(true);
            await expect(staking.withdraw(TRANCHE_M, 10000))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_M, addr1, 10000);
            await shareA.mock.transfer.returns(true);
            await expect(staking.withdraw(TRANCHE_A, 1000))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_A, addr1, 1000);
            await shareB.mock.transfer.returns(true);
            await expect(staking.withdraw(TRANCHE_B, 100))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_B, addr1, 100);
        });
    });

    describe("tradeAvailable()", function () {
        it("Should update balance", async function () {
            await staking.tradeAvailable(TRANCHE_M, addr1, 1000);
            expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.sub(1000));
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.sub(1000));
            await staking.tradeAvailable(TRANCHE_A, addr1, 100);
            expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.sub(100));
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A.sub(100));
            await staking.tradeAvailable(TRANCHE_B, addr1, 10);
            expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.sub(10));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.sub(10));
        });

        it("Should revert if balance is not enough", async function () {
            await expect(staking.tradeAvailable(TRANCHE_M, USER1_M.add(1))).to.be.reverted;
            await expect(staking.tradeAvailable(TRANCHE_A, USER1_A.add(1))).to.be.reverted;
            await expect(staking.tradeAvailable(TRANCHE_B, USER1_B.add(1))).to.be.reverted;
        });
    });

    describe("rebalanceAndClearTrade()", function () {
        it("Should update balance", async function () {
            await staking.rebalanceAndClearTrade(addr1, 1000, 100, 10, 0);
            expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.add(1000));
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.add(1000));
            expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.add(100));
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A.add(100));
            expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.add(10));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.add(10));
        });
    });

    describe("lock()", function () {
        it("Should update balance", async function () {
            await staking.lock(TRANCHE_M, addr1, 1000);
            expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.sub(1000));
            expect(await staking.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(1000);
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M);
            await staking.lock(TRANCHE_A, addr1, 100);
            expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.sub(100));
            expect(await staking.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(100);
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A);
            await staking.lock(TRANCHE_B, addr1, 10);
            expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.sub(10));
            expect(await staking.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(10);
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B);
        });

        it("Should revert if balance is not enough", async function () {
            await expect(staking.lock(TRANCHE_M, addr1, USER1_M.add(1))).to.be.revertedWith(
                "Insufficient balance to lock"
            );
            await expect(staking.lock(TRANCHE_A, addr1, USER1_A.add(1))).to.be.revertedWith(
                "Insufficient balance to lock"
            );
            await expect(staking.lock(TRANCHE_B, addr1, USER1_B.add(1))).to.be.revertedWith(
                "Insufficient balance to lock"
            );
        });
    });

    describe("rebalanceAndUnlock()", function () {
        it("Should update balance", async function () {
            await staking.lock(TRANCHE_M, addr1, 3000);
            await staking.lock(TRANCHE_A, addr1, 300);
            await staking.lock(TRANCHE_B, addr1, 30);

            await staking.rebalanceAndUnlock(addr1, 1000, 100, 10, 0);
            expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.sub(2000));
            expect(await staking.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(2000);
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M);
            expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.sub(200));
            expect(await staking.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(200);
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A);
            expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.sub(20));
            expect(await staking.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(20);
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B);
        });

        it("Should revert if balance is not enough", async function () {
            await staking.lock(TRANCHE_M, addr1, 3000);
            await staking.lock(TRANCHE_A, addr1, 300);
            await staking.lock(TRANCHE_B, addr1, 30);

            await expect(staking.rebalanceAndUnlock(addr1, 3001, 0, 0, 0)).to.be.reverted;
            await expect(staking.rebalanceAndUnlock(addr1, 0, 301, 0, 0)).to.be.reverted;
            await expect(staking.rebalanceAndUnlock(addr1, 0, 0, 31, 0)).to.be.reverted;
        });
    });

    describe("tradeLocked()", function () {
        it("Should update balance", async function () {
            await staking.lock(TRANCHE_M, addr1, 3000);
            await staking.lock(TRANCHE_A, addr1, 300);
            await staking.lock(TRANCHE_B, addr1, 30);

            await staking.tradeLocked(TRANCHE_M, addr1, 1000);
            expect(await staking.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(2000);
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.sub(1000));
            await staking.tradeLocked(TRANCHE_A, addr1, 100);
            expect(await staking.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(200);
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A.sub(100));
            await staking.tradeLocked(TRANCHE_B, addr1, 10);
            expect(await staking.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(20);
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.sub(10));
        });

        it("Should revert if balance is not enough", async function () {
            await staking.lock(TRANCHE_M, addr1, 3000);
            await staking.lock(TRANCHE_A, addr1, 300);
            await staking.lock(TRANCHE_B, addr1, 30);

            await expect(staking.tradeLocked(TRANCHE_M, addr1, 3001)).to.be.reverted;
            await expect(staking.tradeLocked(TRANCHE_A, addr1, 301)).to.be.reverted;
            await expect(staking.tradeLocked(TRANCHE_B, addr1, 31)).to.be.reverted;
        });
    });

    describe("rewardWeight()", function () {
        it("Should calculate reward weight", async function () {
            expect(await staking.rewardWeight(1000, 0, 0)).to.equal(1000);
            expect(await staking.rewardWeight(0, 1000, 0)).to.equal(
                BigNumber.from(1000 * REWARD_WEIGHT_A).div(REWARD_WEIGHT_M)
            );
            expect(await staking.rewardWeight(0, 0, 1000)).to.equal(
                BigNumber.from(1000 * REWARD_WEIGHT_B).div(REWARD_WEIGHT_M)
            );
        });

        it("Should return the weighted value", async function () {
            const m = 1000000;
            const a = 10000;
            const b = 100;
            expect(await staking.rewardWeight(1000000, 10000, 100)).to.equal(
                BigNumber.from(m * REWARD_WEIGHT_M + a * REWARD_WEIGHT_A + b * REWARD_WEIGHT_B).div(
                    REWARD_WEIGHT_M
                )
            );
        });

        it("Should round down reward weight", async function () {
            // Assume weights of (M, A, B) are (3, 4, 2)
            expect(await staking.rewardWeight(0, 1, 0)).to.equal(1);
            expect(await staking.rewardWeight(0, 0, 1)).to.equal(0);
            expect(await staking.rewardWeight(0, 1, 1)).to.equal(2);
        });
    });

    describe("Rebalance", function () {
        describe("availableBalanceOf()", function () {
            it("Should return rebalanced balance", async function () {
                await fund.mock.getRebalanceSize.returns(3);
                await fund.mock.batchRebalance
                    .withArgs(USER1_M, USER1_A, USER1_B, 0, 3)
                    .returns(123, 456, 789);
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(123);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(456);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(789);
            });

            it("Should not perform rebalance if the original balance is zero (for M)", async function () {
                await staking.lock(TRANCHE_M, addr1, USER1_M);
                await staking.lock(TRANCHE_A, addr1, USER1_A);
                await staking.lock(TRANCHE_B, addr1, USER1_B);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for A)", async function () {
                await staking.lock(TRANCHE_A, addr1, USER1_A);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for B)", async function () {
                await staking.lock(TRANCHE_B, addr1, USER1_B);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(0);
            });
        });

        describe("lockedBalanceOf()", function () {
            it("Should return rebalanced balance", async function () {
                await staking.lock(TRANCHE_M, addr1, USER1_M.div(2));
                await staking.lock(TRANCHE_A, addr1, USER1_A.div(3));
                await staking.lock(TRANCHE_B, addr1, USER1_B.div(5));
                await fund.mock.getRebalanceSize.returns(4);
                await fund.mock.batchRebalance
                    .withArgs(USER1_M.div(2), USER1_A.div(3), USER1_B.div(5), 0, 4)
                    .returns(123, 456, 789);
                expect(await staking.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(123);
                expect(await staking.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(456);
                expect(await staking.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(789);
            });

            it("Should not perform rebalance if the original balance is zero (for M)", async function () {
                await fund.mock.getRebalanceSize.returns(4);
                expect(await staking.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for A)", async function () {
                await staking.lock(TRANCHE_M, addr1, USER1_M);
                await staking.lock(TRANCHE_B, addr1, USER1_B);
                await fund.mock.getRebalanceSize.returns(4);
                expect(await staking.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for B)", async function () {
                await staking.lock(TRANCHE_M, addr1, USER1_M);
                await staking.lock(TRANCHE_A, addr1, USER1_A);
                await fund.mock.getRebalanceSize.returns(4);
                expect(await staking.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(0);
            });
        });

        describe("totalSupply()", function () {
            it("Should return rebalanced total supply", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.batchRebalance
                    .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0, 2)
                    .returns(123, 456, 789);
                expect(await staking.totalSupply(TRANCHE_M)).to.equal(123);
                expect(await staking.totalSupply(TRANCHE_A)).to.equal(456);
                expect(await staking.totalSupply(TRANCHE_B)).to.equal(789);
            });
        });

        describe("refreshBalance()", function () {
            it("Non-zero targetVersion", async function () {
                await fund.mock.getRebalanceSize.returns(3);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.getRebalanceTimestamp.withArgs(1).returns(checkpointTimestamp + 2);
                await fund.mock.getRebalanceTimestamp.withArgs(2).returns(checkpointTimestamp + 3);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(addr1, 1)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0),
                        rets: [10000, 1000, 100],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(10000, 1000, 100, 1),
                        rets: [20000, 2000, 200],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(20000, 2000, 200, 2),
                        rets: [30000, 3000, 300],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(USER1_M, USER1_A, USER1_B, 0),
                        rets: [123, 456, 789],
                    }
                );
                expect(await staking.balanceVersion(addr1)).to.equal(1);
                await expect(() => staking.refreshBalance(addr1, 3)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(123, 456, 789, 1),
                        rets: [1230, 4560, 7890],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(1230, 4560, 7890, 2),
                        rets: [12300, 45600, 78900],
                    }
                );
                expect(await staking.balanceVersion(addr1)).to.equal(3);
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(12300);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(45600);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(78900);
            });

            it("Zero targetVersion", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.getRebalanceTimestamp.withArgs(1).returns(checkpointTimestamp + 2);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(addr1, 0)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0),
                        rets: [10000, 1000, 100],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(10000, 1000, 100, 1),
                        rets: [20000, 2000, 200],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(USER1_M, USER1_A, USER1_B, 0),
                        rets: [123, 456, 789],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(123, 456, 789, 1),
                        rets: [1230, 4560, 7890],
                    }
                );
                expect(await staking.balanceVersion(addr1)).to.equal(2);
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(1230);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(4560);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(7890);
            });

            it("Should make no change if targetVersion is older", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.getRebalanceTimestamp.withArgs(1).returns(checkpointTimestamp + 2);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(addr1, 2)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0),
                        rets: [10000, 1000, 100],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(10000, 1000, 100, 1),
                        rets: [20000, 2000, 200],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(USER1_M, USER1_A, USER1_B, 0),
                        rets: [123, 456, 789],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(123, 456, 789, 1),
                        rets: [1230, 4560, 7890],
                    }
                );

                await staking.refreshBalance(addr1, 1);
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(1230);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(4560);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(7890);
            });

            it("Should rebalance both available and locked balance", async function () {
                await staking.lock(TRANCHE_M, addr1, 1000);
                await staking.lock(TRANCHE_A, addr1, 100);
                await staking.lock(TRANCHE_B, addr1, 10);
                await fund.mock.getRebalanceSize.returns(1);
                await fund.mock.getRebalanceTimestamp
                    .withArgs(0)
                    .returns((await ethers.provider.getBlock("latest")).timestamp - 1);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(addr1, 1)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0),
                        rets: [10000, 1000, 100],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(
                            USER1_M.sub(1000),
                            USER1_A.sub(100),
                            USER1_B.sub(10),
                            0
                        ),
                        rets: [123, 456, 789],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(1000, 100, 10, 0),
                        rets: [12, 34, 56],
                    }
                );
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(123);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(456);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(789);
                expect(await staking.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(12);
                expect(await staking.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(34);
                expect(await staking.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(56);
            });

            it("Should rebalance zero balance", async function () {
                await fund.mock.getRebalanceSize.returns(1);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(owner.address, 1)).to.callMocks({
                    func: fund.mock.doRebalance.withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0),
                    rets: [10000, 1000, 100],
                });
                expect(await staking.availableBalanceOf(TRANCHE_M, owner.address)).to.equal(0);
                expect(await staking.availableBalanceOf(TRANCHE_A, owner.address)).to.equal(0);
                expect(await staking.availableBalanceOf(TRANCHE_B, owner.address)).to.equal(0);
                expect(await staking.lockedBalanceOf(TRANCHE_M, owner.address)).to.equal(0);
                expect(await staking.lockedBalanceOf(TRANCHE_A, owner.address)).to.equal(0);
                expect(await staking.lockedBalanceOf(TRANCHE_B, owner.address)).to.equal(0);
            });

            it("Should revert on out-of-bound target version", async function () {
                await fund.mock.getRebalanceSize.returns(1);
                await expect(staking.refreshBalance(addr1, 2)).to.be.revertedWith(
                    "Target version out of bound"
                );
            });
        });

        describe("rebalanceAndClearTrade()", function () {
            it("Should rebalance trade before clearing it", async function () {
                await fund.mock.getRebalanceSize.returns(1);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.doRebalance
                    .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                    .returns(10000, 1000, 100);
                await fund.mock.doRebalance
                    .withArgs(USER1_M, USER1_A, USER1_B, 0)
                    .returns(8000, 800, 80);
                await fund.mock.batchRebalance.withArgs(1230, 4560, 7890, 0, 1).returns(123, 45, 0);
                await staking.rebalanceAndClearTrade(addr1, 1230, 4560, 7890, 0);
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(8123);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(845);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(80);
            });
        });

        describe("rebalanceAndUnlock()", function () {
            it("Should rebalance order amounts before unlock", async function () {
                await staking.lock(TRANCHE_A, addr1, 3000);
                await fund.mock.getRebalanceSize.returns(1);
                await fund.mock.getRebalanceTimestamp
                    .withArgs(0)
                    .returns((await ethers.provider.getBlock("latest")).timestamp - 1);
                await fund.mock.doRebalance
                    .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                    .returns(10000, 1000, 100);
                await fund.mock.doRebalance
                    .withArgs(USER1_M, USER1_A.sub(3000), USER1_B, 0)
                    .returns(8000, 800, 80);
                await fund.mock.doRebalance.withArgs(0, 3000, 0, 0).returns(900, 90, 0);
                await fund.mock.batchRebalance.withArgs(0, 2000, 0, 0, 1).returns(600, 60, 0);
                await staking.rebalanceAndUnlock(addr1, 0, 2000, 0, 0);
                expect(await staking.availableBalanceOf(TRANCHE_M, addr1)).to.equal(8600);
                expect(await staking.availableBalanceOf(TRANCHE_A, addr1)).to.equal(860);
                expect(await staking.availableBalanceOf(TRANCHE_B, addr1)).to.equal(80);
                expect(await staking.lockedBalanceOf(TRANCHE_M, addr1)).to.equal(300);
                expect(await staking.lockedBalanceOf(TRANCHE_A, addr1)).to.equal(30);
                expect(await staking.lockedBalanceOf(TRANCHE_B, addr1)).to.equal(0);
            });
        });
    });

    describe("Rewards", function () {
        let rate1: BigNumber;
        let rate2: BigNumber;

        /**
         * Return claimable rewards of both user at time `claimingTime` if user1's balance
         * increases at `doublingTime` by a certain amount such that the total reward weight
         * doubles.
         */
        function rewardsAfterDoublingTotal(
            doublingTime: number,
            claimingTime: number
        ): { rewards1: BigNumber; rewards2: BigNumber } {
            const formerRewards1 = rate1.mul(doublingTime);
            // User1 rewards between doublingTime and claimingTime
            // `rate1 * (claimingTime - doublingTime) / 2` for the origin balance, plus
            // half of the total rewards in this period for the increased balance
            const latterRewards1 = rate1
                .div(2)
                .add(parseEther("0.5"))
                .mul(claimingTime - doublingTime);
            const rewards1 = formerRewards1.add(latterRewards1);
            const rewards2 = parseEther("1").mul(claimingTime).sub(rewards1);
            return { rewards1, rewards2 };
        }

        /*
         * Return claimable rewards of both user at time `claimingTime` if user1's balance
         * decreases at `doublingTime` by a certain amount such that the total reward weight
         * reduces to 80%.
         */
        function rewardsAfterReducingTotal(
            doublingTime: number,
            claimingTime: number
        ): { rewards1: BigNumber; rewards2: BigNumber } {
            const formerRewards2 = rate2.mul(doublingTime);
            // original rewards / 80%
            const latterRewards2 = rate2
                .mul(claimingTime - doublingTime)
                .mul(5)
                .div(4);
            const rewards2 = formerRewards2.add(latterRewards2);
            const rewards1 = parseEther("1").mul(claimingTime).sub(rewards2);
            return { rewards1, rewards2 };
        }

        beforeEach(async function () {
            // Trigger a checkpoint and record its block timestamp. Reward rate is zero before
            // this checkpoint. So no one has rewards till now.
            await fund.mock.getRebalanceTimestamp
                .withArgs(0)
                .returns(nextRateUpdateTime + 100 * WEEK);
            await chess.mock.getRate.withArgs(nextRateUpdateTime).returns(parseEther("1"));
            await advanceBlockAtTime(nextRateUpdateTime);

            rate1 = parseEther("1").mul(USER1_WEIGHT).div(TOTAL_WEIGHT);
            rate2 = parseEther("1").mul(USER2_WEIGHT).div(TOTAL_WEIGHT);
        });

        it("Should mint rewards on claimRewards()", async function () {
            await advanceBlockAtTime(nextRateUpdateTime + 100);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rate1.mul(100));
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rate2.mul(100));

            await expect(async () => {
                await setNextBlockTime(nextRateUpdateTime + 300);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chess.mock.mint.withArgs(addr1, rate1.mul(300)),
            });

            await advanceBlockAtTime(nextRateUpdateTime + 800);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rate1.mul(500));
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rate2.mul(800));

            await expect(async () => {
                await setNextBlockTime(nextRateUpdateTime + 1000);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chess.mock.mint.withArgs(addr1, rate1.mul(700)),
            });
        });

        it("Should make a checkpoint on deposit()", async function () {
            // Deposit some Token A to double the total reward weight
            await shareA.mock.transferFrom.returns(true);
            await setNextBlockTime(nextRateUpdateTime + 100);
            await staking.deposit(
                TRANCHE_A,
                TOTAL_WEIGHT.mul(REWARD_WEIGHT_M).div(REWARD_WEIGHT_A)
            );

            await advanceBlockAtTime(nextRateUpdateTime + 500);
            const { rewards1, rewards2 } = rewardsAfterDoublingTotal(100, 500);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should make a checkpoint on withdraw()", async function () {
            // Withdraw some Token M to reduce 20% of the total reward weight,
            // assuming balance is enough
            await shareM.mock.transfer.returns(true);
            await setNextBlockTime(nextRateUpdateTime + 200);
            await staking.withdraw(TRANCHE_M, TOTAL_WEIGHT.div(5));

            await advanceBlockAtTime(nextRateUpdateTime + 700);
            const { rewards1, rewards2 } = rewardsAfterReducingTotal(200, 700);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should make a checkpoint on tradeAvailable()", async function () {
            // Trade some Token M to reduce 20% of the total reward weight, assuming balance is enough
            await shareM.mock.transfer.returns(true);
            await setNextBlockTime(nextRateUpdateTime + 300);
            await staking.tradeAvailable(TRANCHE_M, addr1, TOTAL_WEIGHT.div(5));

            await advanceBlockAtTime(nextRateUpdateTime + 900);
            const { rewards1, rewards2 } = rewardsAfterReducingTotal(300, 900);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should make a checkpoint on rebalanceAndClearTrade()", async function () {
            // Get some Token B by settling trade to double the total reward weight
            await shareA.mock.transferFrom.returns(true);
            await setNextBlockTime(nextRateUpdateTime + 400);
            await staking.rebalanceAndClearTrade(
                addr1,
                0,
                0,
                TOTAL_WEIGHT.mul(REWARD_WEIGHT_M).div(REWARD_WEIGHT_B),
                0
            );

            await advanceBlockAtTime(nextRateUpdateTime + 1500);
            const { rewards1, rewards2 } = rewardsAfterDoublingTotal(400, 1500);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should have no difference in rewarding available and locked balance", async function () {
            await setNextBlockTime(nextRateUpdateTime + 300);
            await staking.lock(TRANCHE_M, addr1, USER1_M.div(2));
            await setNextBlockTime(nextRateUpdateTime + 350);
            await staking.lock(TRANCHE_A, addr1, USER1_A.div(3));
            await setNextBlockTime(nextRateUpdateTime + 400);
            await staking.lock(TRANCHE_B, addr2, USER2_B.div(4));

            await advanceBlockAtTime(nextRateUpdateTime + 500);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rate1.mul(500));
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rate2.mul(500));

            await setNextBlockTime(nextRateUpdateTime + 700);
            await staking.rebalanceAndUnlock(addr1, USER1_M.div(3), 0, 0, 0);
            await setNextBlockTime(nextRateUpdateTime + 750);
            await staking.rebalanceAndUnlock(addr1, 0, USER1_A.div(5), 0, 0);
            await setNextBlockTime(nextRateUpdateTime + 800);
            await staking.rebalanceAndUnlock(addr2, 0, 0, USER2_B.div(7), 0);

            await advanceBlockAtTime(nextRateUpdateTime + 2000);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rate1.mul(2000));
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rate2.mul(2000));
        });

        it("Should make a checkpoint on tradeLocked()", async function () {
            // Trade some locked Token M to reduce 20% of the total reward weight
            await shareM.mock.transfer.returns(true);
            await setNextBlockTime(nextRateUpdateTime + 789);
            await staking.lock(TRANCHE_M, addr1, USER1_M);
            await setNextBlockTime(nextRateUpdateTime + 1234);
            await staking.tradeLocked(TRANCHE_M, addr1, TOTAL_WEIGHT.div(5));

            await advanceBlockAtTime(nextRateUpdateTime + 5678);
            const { rewards1, rewards2 } = rewardsAfterReducingTotal(1234, 5678);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should calculate rewards for two users in multiple weeks", async function () {
            await chess.mock.getRate.withArgs(nextRateUpdateTime + WEEK).returns(parseEther("2"));
            await chess.mock.getRate
                .withArgs(nextRateUpdateTime + WEEK * 2)
                .returns(parseEther("3"));
            await chess.mock.getRate
                .withArgs(nextRateUpdateTime + WEEK * 3)
                .returns(parseEther("4"));

            let balance1 = rate1.mul(WEEK);
            let balance2 = rate2.mul(WEEK);
            await advanceBlockAtTime(nextRateUpdateTime + WEEK);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(balance1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(balance2);

            balance1 = balance1.add(rate1.mul(WEEK).mul(2));
            balance2 = balance2.add(rate2.mul(WEEK).mul(2));
            await expect(async () => {
                await setNextBlockTime(nextRateUpdateTime + WEEK * 2);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chess.mock.mint.withArgs(addr1, balance1),
            });

            balance1 = balance1
                .add(rate1.mul(WEEK).mul(3))
                .sub(rate1.mul(WEEK).mul(2))
                .sub(rate1.mul(WEEK));
            balance2 = balance2.add(rate2.mul(WEEK).mul(3));
            await advanceBlockAtTime(nextRateUpdateTime + WEEK * 3);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(balance1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(balance2);

            balance1 = balance1.add(rate1.mul(WEEK).mul(4));
            balance2 = balance2.add(rate2.mul(WEEK).mul(4));
            await expect(async () => {
                await setNextBlockTime(nextRateUpdateTime + WEEK * 4);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chess.mock.mint.withArgs(addr1, balance1),
            });
        });

        it("Should calculate rewards with rebalance in two weeks", async function () {
            await chess.mock.getRate
                .withArgs(nextRateUpdateTime + WEEK * 1)
                .returns(parseEther("3"));
            await chess.mock.getRate
                .withArgs(nextRateUpdateTime + WEEK * 2)
                .returns(parseEther("5"));
            await fund.mock.getRebalanceSize.returns(1);
            await fund.mock.getRebalanceTimestamp
                .withArgs(0)
                .returns(nextRateUpdateTime + WEEK + 100);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                .returns(TOTAL_M.mul(4), TOTAL_A.mul(4), TOTAL_B.mul(4));
            await fund.mock.doRebalance
                .withArgs(TOTAL_M.mul(4), TOTAL_A.mul(4), TOTAL_B.mul(4), 1)
                .returns(TOTAL_M.mul(15), TOTAL_A.mul(15), TOTAL_B.mul(15));
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 0)
                .returns(USER1_M.mul(2), USER1_A.mul(2), USER1_B.mul(2));
            await fund.mock.doRebalance
                .withArgs(USER1_M.mul(2), USER1_A.mul(2), USER1_B.mul(2), 1)
                .returns(USER1_M.mul(3), USER1_A.mul(3), USER1_B.mul(3));
            await advanceBlockAtTime(nextRateUpdateTime + WEEK * 2 + 100);

            const rewardWeek0Version0 = rate1.mul(WEEK);
            const rewardWeek1Version0 = rate1.mul(3).mul(100);
            const rewardWeek1Version1 = rate1
                .mul(3)
                .mul(WEEK - 100)
                .div(2);
            const rewardWeek2Version1 = rate1.mul(5).mul(100).div(2);
            const expectedRewards = rewardWeek0Version0
                .add(rewardWeek1Version0)
                .add(rewardWeek1Version1)
                .add(rewardWeek2Version1);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(expectedRewards);
        });

        it("Should handle multiple checkpoints in the same block correctly", async function () {
            // Deposit some Token A to double the total reward weight, in three transactions
            const totalDeposit = TOTAL_WEIGHT.mul(REWARD_WEIGHT_M).div(REWARD_WEIGHT_A);
            const deposit1 = totalDeposit.div(4);
            const deposit2 = totalDeposit.div(3);
            const deposit3 = totalDeposit.sub(deposit1).sub(deposit2);
            await shareA.mock.transferFrom.returns(true);
            await setAutomine(false);
            await staking.deposit(TRANCHE_A, deposit1);
            await staking.deposit(TRANCHE_A, deposit2);
            await staking.deposit(TRANCHE_A, deposit3);
            await advanceBlockAtTime(nextRateUpdateTime + 100);
            await setAutomine(true);

            await advanceBlockAtTime(nextRateUpdateTime + 500);
            const { rewards1, rewards2 } = rewardsAfterDoublingTotal(100, 500);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should calculate rewards after each rebalance", async function () {
            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(nextRateUpdateTime + 100);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(nextRateUpdateTime + 400);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                .returns(TOTAL_M.mul(4), TOTAL_A.mul(4), TOTAL_B.mul(4));
            await fund.mock.doRebalance
                .withArgs(TOTAL_M.mul(4), TOTAL_A.mul(4), TOTAL_B.mul(4), 1)
                .returns(TOTAL_M.mul(15), TOTAL_A.mul(15), TOTAL_B.mul(15));
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 0)
                .returns(USER1_M.mul(2), USER1_A.mul(2), USER1_B.mul(2));
            await fund.mock.doRebalance
                .withArgs(USER1_M.mul(2), USER1_A.mul(2), USER1_B.mul(2), 1)
                .returns(USER1_M.mul(3), USER1_A.mul(3), USER1_B.mul(3));
            await advanceBlockAtTime(nextRateUpdateTime + 1000);

            const rewardVersion0 = rate1.mul(100);
            const rewardVersion1 = rate1.div(2).mul(300); // Half (2/4) rate1 after the first rebalance
            const rewardVersion2 = rate1.div(5).mul(600); // One-fifth (3/15) rate1 after the first rebalance
            const expectedRewards = rewardVersion0.add(rewardVersion1).add(rewardVersion2);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(expectedRewards);
        });

        it("Should be able to handle zero total supplies between two rebalances", async function () {
            // Withdraw all Token M and A (in a single block to make rewards calculation easy)
            await shareM.mock.transfer.returns(true);
            await shareA.mock.transfer.returns(true);
            await shareM.mock.transferFrom.returns(true);
            await setAutomine(false);
            await staking.withdraw(TRANCHE_M, USER1_M);
            await staking.withdraw(TRANCHE_A, USER1_A);
            await staking.connect(user2).withdraw(TRANCHE_M, USER2_M);
            await staking.connect(user2).withdraw(TRANCHE_A, USER2_A);
            await advanceBlockAtTime(nextRateUpdateTime + 100);
            await setAutomine(true);
            // Rewards before the withdrawals
            let user1Rewards = rate1.mul(100);
            let user2Rewards = rate2.mul(100);

            // Rebalance any Token B to zero in the first rebalance.
            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(nextRateUpdateTime + 400);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(nextRateUpdateTime + 1000);
            await fund.mock.doRebalance.withArgs(0, 0, TOTAL_B, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, USER1_B, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, USER2_B, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, 0, 1).returns(0, 0, 0);
            // Add rewards till the first rebalance
            user1Rewards = user1Rewards.add(parseEther("1").mul(300).mul(USER1_B).div(TOTAL_B));
            user2Rewards = user2Rewards.add(parseEther("1").mul(300).mul(USER2_B).div(TOTAL_B));

            // User1 deposit some Token M
            await setNextBlockTime(nextRateUpdateTime + 2000);
            await staking.deposit(TRANCHE_M, parseEther("1"));

            // User2 deposit some Token M
            await setNextBlockTime(nextRateUpdateTime + 3500);
            await staking.connect(user2).deposit(TRANCHE_M, parseEther("1"));
            // Add rewards before user2's deposit
            user1Rewards = user1Rewards.add(parseEther("1").mul(1500));

            await advanceBlockAtTime(nextRateUpdateTime + 5600);
            // The two users evenly split rewards after user2's deposit
            user1Rewards = user1Rewards.add(parseEther("0.5").mul(2100));
            user2Rewards = user2Rewards.add(parseEther("0.5").mul(2100));
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(user1Rewards);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(user2Rewards);
        });
    });
});
