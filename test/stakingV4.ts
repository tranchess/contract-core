import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import {
    TRANCHE_M,
    TRANCHE_A,
    TRANCHE_B,
    DAY,
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
    setAutomine,
} from "./utils";
import {
    REWARD_WEIGHT_M,
    REWARD_WEIGHT_A,
    REWARD_WEIGHT_B,
    boostedWorkingBalance,
} from "./stakingV2Formula";

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

// veCHESS proportion:
// User 1: 30%
// User 2: 70%
// Boosted staking weight:
// User 1: 680 + 1000 * 30% * (3 - 1) = 1280
// User 2: 320 * 3 = 960
// Total : 1280 + 960 = 2240
const USER1_VE = parseEther("0.03");
const USER2_VE = parseEther("0.07");
const TOTAL_VE = parseEther("0.1");
const USER1_VE_PROPORTION = USER1_VE.mul(parseEther("1")).div(TOTAL_VE);
const USER2_VE_PROPORTION = USER2_VE.mul(parseEther("1")).div(TOTAL_VE);

const USER1_WORKING_BALANCE = boostedWorkingBalance(
    USER1_M,
    USER1_A,
    USER1_B,
    TOTAL_WEIGHT,
    USER1_VE_PROPORTION
);
const USER2_WORKING_BALANCE = boostedWorkingBalance(
    USER2_M,
    USER2_A,
    USER2_B,
    TOTAL_WEIGHT,
    USER2_VE_PROPORTION
);
const WORKING_SUPPLY = USER1_WORKING_BALANCE.add(USER2_WORKING_BALANCE);

describe("StakingV4", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly checkpointTimestamp: number;
        readonly fund: MockContract;
        readonly chessSchedule: MockContract;
        readonly chessController: MockContract;
        readonly votingEscrow: MockContract;
        readonly usdc: Contract;
        readonly staking: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let checkpointTimestamp: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let fund: MockContract;
    let chessSchedule: MockContract;
    let chessController: MockContract;
    let votingEscrow: MockContract;
    let usdc: Contract;
    let staking: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        const startEpoch = (await ethers.provider.getBlock("latest")).timestamp;
        await advanceBlockAtTime(Math.floor(startEpoch / WEEK) * WEEK + WEEK);

        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.getRebalanceSize.returns(0);

        const chessSchedule = await deployMockForName(owner, "IChessSchedule");
        await chessSchedule.mock.getRate.returns(0);

        const chessController = await deployMockForName(
            owner,
            "contracts/interfaces/IChessController.sol:IChessController"
        );
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");

        const Staking = await ethers.getContractFactory("StakingV4");
        const staking = await Staking.connect(owner).deploy(
            fund.address,
            chessSchedule.address,
            chessController.address,
            votingEscrow.address
        );
        await staking.initialize();

        // Deposit initial shares
        await fund.mock.trancheTransferFrom.returns();
        await staking.connect(user1).deposit(TRANCHE_M, USER1_M, 0);
        await staking.connect(user1).deposit(TRANCHE_A, USER1_A, 0);
        await staking.connect(user1).deposit(TRANCHE_B, USER1_B, 0);
        await staking.connect(user2).deposit(TRANCHE_M, USER2_M, 0);
        await staking.connect(user2).deposit(TRANCHE_A, USER2_A, 0);
        await staking.connect(user2).deposit(TRANCHE_B, USER2_B, 0);
        const checkpointTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        await fund.mock.trancheTransferFrom.revertsWithReason(
            "Mock on the method is not initialized"
        );

        return {
            wallets: { user1, user2, owner },
            checkpointTimestamp,
            fund,
            chessSchedule,
            chessController,
            votingEscrow,
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
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        addr2 = user2.address;
        fund = fixtureData.fund;
        chessSchedule = fixtureData.chessSchedule;
        chessController = fixtureData.chessController;
        votingEscrow = fixtureData.votingEscrow;
        usdc = fixtureData.usdc;
        staking = fixtureData.staking;
    });

    describe("deposit()", function () {
        it("Should transfer shares and update balance", async function () {
            await expect(() => staking.deposit(TRANCHE_M, 10000, 0)).to.callMocks({
                func: fund.mock.trancheTransferFrom.withArgs(
                    TRANCHE_M,
                    addr1,
                    staking.address,
                    10000,
                    0
                ),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.add(10000));
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.add(10000));
            await expect(() => staking.deposit(TRANCHE_A, 1000, 0)).to.callMocks({
                func: fund.mock.trancheTransferFrom.withArgs(
                    TRANCHE_A,
                    addr1,
                    staking.address,
                    1000,
                    0
                ),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.add(1000));
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A.add(1000));
            await expect(() => staking.deposit(TRANCHE_B, 100, 0)).to.callMocks({
                func: fund.mock.trancheTransferFrom.withArgs(
                    TRANCHE_B,
                    addr1,
                    staking.address,
                    100,
                    0
                ),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.add(100));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.add(100));
        });

        it("Should emit an event", async function () {
            await fund.mock.trancheTransferFrom.returns();
            await expect(staking.deposit(TRANCHE_M, 10000, 0))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_M, addr1, 10000);
            await expect(staking.deposit(TRANCHE_A, 1000, 0))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_A, addr1, 1000);
            await expect(staking.deposit(TRANCHE_B, 100, 0))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_B, addr1, 100);
        });
    });

    describe("withdraw()", function () {
        it("Should transfer shares and update balance", async function () {
            await expect(() => staking.withdraw(TRANCHE_M, 1000, 0)).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_M, addr1, 1000, 0),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(USER1_M.sub(1000));
            expect(await staking.totalSupply(TRANCHE_M)).to.equal(TOTAL_M.sub(1000));
            await expect(() => staking.withdraw(TRANCHE_A, 100, 0)).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_A, addr1, 100, 0),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(USER1_A.sub(100));
            expect(await staking.totalSupply(TRANCHE_A)).to.equal(TOTAL_A.sub(100));
            await expect(() => staking.withdraw(TRANCHE_B, 10, 0)).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr1, 10, 0),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.sub(10));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.sub(10));
        });

        it("Should revert if balance is not enough", async function () {
            await expect(staking.withdraw(TRANCHE_M, USER1_M.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
            await expect(staking.withdraw(TRANCHE_A, USER1_A.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
            await expect(staking.withdraw(TRANCHE_B, USER1_B.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
        });

        it("Should emit an event", async function () {
            await fund.mock.trancheTransfer.returns();
            await expect(staking.withdraw(TRANCHE_M, 10000, 0))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_M, addr1, 10000);
            await expect(staking.withdraw(TRANCHE_A, 1000, 0))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_A, addr1, 1000);
            await expect(staking.withdraw(TRANCHE_B, 100, 0))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_B, addr1, 100);
        });
    });

    describe("weightedBalance()", function () {
        it("Should calculate weighted balance", async function () {
            expect(await staking.weightedBalance(1000, 0, 0)).to.equal(1000);
            expect(await staking.weightedBalance(0, 1000, 0)).to.equal(
                BigNumber.from(1000 * REWARD_WEIGHT_A).div(REWARD_WEIGHT_M)
            );
            expect(await staking.weightedBalance(0, 0, 1000)).to.equal(
                BigNumber.from(1000 * REWARD_WEIGHT_B).div(REWARD_WEIGHT_M)
            );
        });

        it("Should return the weighted value", async function () {
            const m = 1000000;
            const a = 10000;
            const b = 100;
            expect(await staking.weightedBalance(1000000, 10000, 100)).to.equal(
                BigNumber.from(m * REWARD_WEIGHT_M + a * REWARD_WEIGHT_A + b * REWARD_WEIGHT_B).div(
                    REWARD_WEIGHT_M
                )
            );
        });

        it("Should round down weighted balance", async function () {
            // Assume weights of (M, A, B) are (3, 4, 2)
            expect(await staking.weightedBalance(0, 1, 0)).to.equal(1);
            expect(await staking.weightedBalance(0, 0, 1)).to.equal(0);
            expect(await staking.weightedBalance(0, 1, 1)).to.equal(2);
        });
    });

    describe("syncWithVotingEscrow()", function () {
        const lockedAmount1 = parseEther("150");
        const lockedAmount2 = parseEther("700");
        let unlockTime1: number;
        let unlockTime2: number;

        beforeEach(async function () {
            unlockTime1 = checkpointTimestamp + WEEK * 20;
            unlockTime2 = checkpointTimestamp + WEEK * 10;
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([lockedAmount1, unlockTime1]);
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr2)
                .returns([lockedAmount2, unlockTime2]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.balanceOf.withArgs(addr2).returns(USER2_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
        });

        it("Should update everything the first time", async function () {
            await staking.syncWithVotingEscrow(addr1);
            const veSnapshot1 = await staking.veSnapshotOf(addr1);
            expect(veSnapshot1.veLocked.amount).to.equal(lockedAmount1);
            expect(veSnapshot1.veLocked.unlockTime).to.equal(unlockTime1);
            expect(veSnapshot1.veProportion).to.equal(USER1_VE_PROPORTION);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await staking.workingSupply()).to.equal(USER1_WORKING_BALANCE.add(USER2_WEIGHT));

            await staking.syncWithVotingEscrow(addr2);
            const veSnapshot2 = await staking.veSnapshotOf(addr2);
            expect(veSnapshot2.veLocked.amount).to.equal(lockedAmount2);
            expect(veSnapshot2.veLocked.unlockTime).to.equal(unlockTime2);
            expect(veSnapshot2.veProportion).to.equal(USER2_VE_PROPORTION);
            expect(await staking.workingBalanceOf(addr2)).to.equal(USER2_WORKING_BALANCE);
            expect(await staking.workingSupply()).to.equal(WORKING_SUPPLY);
        });

        it("Should not update ve proportion when no locking action is taken", async function () {
            await staking.syncWithVotingEscrow(addr1);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE.div(2));
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE.mul(2));
            await staking.syncWithVotingEscrow(addr1);
            const veSnapshot = await staking.veSnapshotOf(addr1);
            expect(veSnapshot.veLocked.amount).to.equal(lockedAmount1);
            expect(veSnapshot.veLocked.unlockTime).to.equal(unlockTime1);
            expect(veSnapshot.veProportion).to.equal(USER1_VE_PROPORTION);
        });

        it("Should still update working balance when no locking action is taken", async function () {
            await staking.syncWithVotingEscrow(addr1);
            await fund.mock.trancheTransferFrom.returns();
            await staking.connect(user2).deposit(TRANCHE_M, TOTAL_WEIGHT, 0); // Weighted total supply doubles
            await staking.syncWithVotingEscrow(addr1);
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_M,
                    USER1_A,
                    USER1_B,
                    TOTAL_WEIGHT.mul(2),
                    USER1_VE_PROPORTION
                )
            );
            expect(await staking.workingSupply()).to.equal(
                workingBalance.add(USER2_WEIGHT).add(TOTAL_WEIGHT)
            );
        });

        it("Should update ve proportion if locked amount changed", async function () {
            await staking.syncWithVotingEscrow(addr1);
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([lockedAmount1.mul(2), unlockTime1]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE.mul(2));
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE.mul(5));
            await staking.syncWithVotingEscrow(addr1);
            const veSnapshot = await staking.veSnapshotOf(addr1);
            expect(veSnapshot.veLocked.amount).to.equal(lockedAmount1.mul(2));
            expect(veSnapshot.veProportion).to.equal(
                USER1_VE.mul(2).mul(parseEther("1")).div(TOTAL_VE.mul(5))
            );
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_M,
                    USER1_A,
                    USER1_B,
                    TOTAL_WEIGHT,
                    veSnapshot.veProportion
                )
            );
            expect(await staking.workingSupply()).to.equal(workingBalance.add(USER2_WEIGHT));
        });

        it("Should update ve proportion if unlock time extended", async function () {
            await staking.syncWithVotingEscrow(addr1);
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([lockedAmount1, unlockTime1 + WEEK * 20]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE.mul(2));
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE.mul(5));
            await staking.syncWithVotingEscrow(addr1);
            const veSnapshot = await staking.veSnapshotOf(addr1);
            expect(veSnapshot.veLocked.unlockTime).to.equal(unlockTime1 + WEEK * 20);
            expect(veSnapshot.veProportion).to.equal(
                USER1_VE.mul(2).mul(parseEther("1")).div(TOTAL_VE.mul(5))
            );
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_M,
                    USER1_A,
                    USER1_B,
                    TOTAL_WEIGHT,
                    veSnapshot.veProportion
                )
            );
            expect(await staking.workingSupply()).to.equal(workingBalance.add(USER2_WEIGHT));
        });

        it("Should update ve proportion if lock expires", async function () {
            await staking.syncWithVotingEscrow(addr1);
            await advanceBlockAtTime(unlockTime1);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(0);
            await staking.syncWithVotingEscrow(addr1);
            const veSnapshot = await staking.veSnapshotOf(addr1);
            expect(veSnapshot.veProportion).to.equal(0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WEIGHT);
            expect(await staking.workingSupply()).to.equal(TOTAL_WEIGHT);
        });
    });

    describe("Working balance update due to balance change", function () {
        beforeEach(async function () {
            await votingEscrow.mock.getLockedBalance.returns([100, checkpointTimestamp + WEEK]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await staking.syncWithVotingEscrow(addr1);
        });

        it("Should update working balance on deposit()", async function () {
            await fund.mock.trancheTransferFrom.returns();
            await staking.deposit(TRANCHE_M, USER1_M, 0);
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_M.add(USER1_M),
                    USER1_A,
                    USER1_B,
                    TOTAL_WEIGHT.add(USER1_M),
                    USER1_VE_PROPORTION
                )
            );
            expect(await staking.workingSupply()).to.equal(workingBalance.add(USER2_WEIGHT));
        });

        it("Should update working balance on withdraw()", async function () {
            await fund.mock.trancheTransfer.returns();
            await staking.withdraw(TRANCHE_M, USER1_M, 0);
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    BigNumber.from(0),
                    USER1_A,
                    USER1_B,
                    TOTAL_WEIGHT.sub(USER1_M),
                    USER1_VE_PROPORTION
                )
            );
            expect(await staking.workingSupply()).to.equal(workingBalance.add(USER2_WEIGHT));
        });

        it("Should update working balance when reaching max boosting power of M", async function () {
            await fund.mock.trancheTransfer.returns();
            await fund.mock.trancheTransferFrom.returns();
            await staking.connect(user2).deposit(TRANCHE_A, USER1_A, 0); // To keep weighted supply unchanged
            await staking.withdraw(TRANCHE_A, USER1_A, 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(
                boostedWorkingBalance(
                    USER1_M,
                    BigNumber.from(0),
                    USER1_B,
                    TOTAL_WEIGHT,
                    USER1_VE_PROPORTION
                )
            );

            await staking.connect(user2).deposit(TRANCHE_B, USER1_B, 0); // To keep weighted supply unchanged
            await staking.withdraw(TRANCHE_B, USER1_B, 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(
                boostedWorkingBalance(
                    USER1_M,
                    BigNumber.from(0),
                    BigNumber.from(0),
                    TOTAL_WEIGHT,
                    USER1_VE_PROPORTION
                )
            );

            await staking.connect(user2).deposit(TRANCHE_M, USER1_M.div(2), 0); // To keep weighted supply unchanged
            await staking.withdraw(TRANCHE_M, USER1_M.div(2), 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(
                boostedWorkingBalance(
                    USER1_M.div(2),
                    BigNumber.from(0),
                    BigNumber.from(0),
                    TOTAL_WEIGHT,
                    USER1_VE_PROPORTION
                )
            );
        });

        it("Should not update working balance on refreshBalance()", async function () {
            await staking.refreshBalance(addr1, 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await staking.workingSupply()).to.equal(USER1_WORKING_BALANCE.add(USER2_WEIGHT));
        });

        it("Should not update working balance on claimRewards()", async function () {
            await chessSchedule.mock.mint.returns();
            await staking.claimRewards(addr1);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await staking.workingSupply()).to.equal(USER1_WORKING_BALANCE.add(USER2_WEIGHT));
        });

        it("Should reset working balance without boosting after rebalance", async function () {
            await fund.mock.getRebalanceSize.returns(1);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 100);
            await advanceBlockAtTime(checkpointTimestamp + 100);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 0)
                .returns(USER1_M, USER1_A, USER1_B);

            await staking.refreshBalance(addr1, 1);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WEIGHT);
            expect(await staking.workingSupply()).to.equal(TOTAL_WEIGHT);
        });
    });

    describe("Rebalance", function () {
        describe("trancheBalanceOf()", function () {
            it("Should return rebalanced balance", async function () {
                await fund.mock.getRebalanceSize.returns(3);
                await fund.mock.batchRebalance
                    .withArgs(USER1_M, USER1_A, USER1_B, 0, 3)
                    .returns(123, 456, 789);
                expect(await staking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(123);
                expect(await staking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(456);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(789);
            });

            it("Should not perform rebalance if the original balance is zero (for M)", async function () {
                await fund.mock.trancheTransfer.returns();
                await staking.withdraw(TRANCHE_M, USER1_M, 0);
                await staking.withdraw(TRANCHE_A, USER1_A, 0);
                await staking.withdraw(TRANCHE_B, USER1_B, 0);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for A)", async function () {
                await fund.mock.trancheTransfer.returns();
                await staking.withdraw(TRANCHE_A, USER1_A, 0);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for B)", async function () {
                await fund.mock.trancheTransfer.returns();
                await staking.withdraw(TRANCHE_B, USER1_B, 0);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(0);
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

        describe("workingSupply()", function () {
            it("Should return rebalanced working supply (without boosting)", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.batchRebalance
                    .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0, 2)
                    .returns(TOTAL_M.mul(3), TOTAL_A.mul(3), TOTAL_B.mul(3));
                expect(await staking.workingSupply()).to.equal(TOTAL_WEIGHT.mul(3));
            });
        });

        describe("workingBalanceOf()", function () {
            it("Should return rebalanced working balance (without boosting)", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.batchRebalance
                    .withArgs(USER1_M, USER1_A, USER1_B, 0, 2)
                    .returns(USER1_M.mul(8), USER1_A.mul(8), USER1_B.mul(8));
                expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WEIGHT.mul(8));
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
                expect(await staking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(12300);
                expect(await staking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(45600);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(78900);
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
                expect(await staking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(1230);
                expect(await staking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(4560);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(7890);
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
                expect(await staking.trancheBalanceOf(TRANCHE_M, addr1)).to.equal(1230);
                expect(await staking.trancheBalanceOf(TRANCHE_A, addr1)).to.equal(4560);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(7890);
            });

            it("Should rebalance zero balance", async function () {
                await fund.mock.getRebalanceSize.returns(1);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(owner.address, 1)).to.callMocks({
                    func: fund.mock.doRebalance.withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0),
                    rets: [10000, 1000, 100],
                });
                expect(await staking.trancheBalanceOf(TRANCHE_M, owner.address)).to.equal(0);
                expect(await staking.trancheBalanceOf(TRANCHE_A, owner.address)).to.equal(0);
                expect(await staking.trancheBalanceOf(TRANCHE_B, owner.address)).to.equal(0);
            });

            it("Should revert on out-of-bound target version", async function () {
                await fund.mock.getRebalanceSize.returns(1);
                await expect(staking.refreshBalance(addr1, 2)).to.be.revertedWith(
                    "Target version out of bound"
                );
            });
        });
    });

    describe("Rewards", function () {
        let rewardStartTimestamp: number; // Reward rate becomes non-zero at this timestamp.
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
            rewardStartTimestamp =
                Math.floor(checkpointTimestamp / WEEK) * WEEK + WEEK * 10 + SETTLEMENT_TIME;
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp)
                .returns(parseEther("1"));
            await advanceBlockAtTime(rewardStartTimestamp);

            rate1 = parseEther("1").mul(USER1_WEIGHT).div(TOTAL_WEIGHT);
            rate2 = parseEther("1").mul(USER2_WEIGHT).div(TOTAL_WEIGHT);
        });

        it("Should mint rewards on claimRewards()", async function () {
            await advanceBlockAtTime(rewardStartTimestamp + 100);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rate1.mul(100));
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rate2.mul(100));

            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + 300);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chessSchedule.mock.mint.withArgs(addr1, rate1.mul(300)),
            });

            await advanceBlockAtTime(rewardStartTimestamp + 800);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rate1.mul(500));
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rate2.mul(800));

            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + 1000);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chessSchedule.mock.mint.withArgs(addr1, rate1.mul(700)),
            });
        });

        it("Should make a checkpoint on deposit()", async function () {
            // Deposit some Token A to double the total reward weight
            await fund.mock.trancheTransferFrom.returns();
            await setNextBlockTime(rewardStartTimestamp + 100);
            await staking.deposit(
                TRANCHE_A,
                TOTAL_WEIGHT.mul(REWARD_WEIGHT_M).div(REWARD_WEIGHT_A),
                0
            );

            await advanceBlockAtTime(rewardStartTimestamp + 500);
            const { rewards1, rewards2 } = rewardsAfterDoublingTotal(100, 500);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should make a checkpoint on withdraw()", async function () {
            // Withdraw some Token M to reduce 20% of the total reward weight,
            // assuming balance is enough
            await fund.mock.trancheTransfer.returns();
            await setNextBlockTime(rewardStartTimestamp + 200);
            await staking.withdraw(TRANCHE_M, TOTAL_WEIGHT.div(5), 0);

            await advanceBlockAtTime(rewardStartTimestamp + 700);
            const { rewards1, rewards2 } = rewardsAfterReducingTotal(200, 700);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should calculate rewards for two users in multiple weeks", async function () {
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp + WEEK)
                .returns(parseEther("2"));
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp + WEEK * 2)
                .returns(parseEther("3"));
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp + WEEK * 3)
                .returns(parseEther("4"));

            let balance1 = rate1.mul(WEEK);
            let balance2 = rate2.mul(WEEK);
            await advanceBlockAtTime(rewardStartTimestamp + WEEK);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(balance1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(balance2);

            balance1 = balance1.add(rate1.mul(WEEK).mul(2));
            balance2 = balance2.add(rate2.mul(WEEK).mul(2));
            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + WEEK * 2);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chessSchedule.mock.mint.withArgs(addr1, balance1),
            });

            balance1 = balance1
                .add(rate1.mul(WEEK).mul(3))
                .sub(rate1.mul(WEEK).mul(2))
                .sub(rate1.mul(WEEK));
            balance2 = balance2.add(rate2.mul(WEEK).mul(3));
            await advanceBlockAtTime(rewardStartTimestamp + WEEK * 3);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(balance1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(balance2);

            balance1 = balance1.add(rate1.mul(WEEK).mul(4));
            balance2 = balance2.add(rate2.mul(WEEK).mul(4));
            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + WEEK * 4);
                await staking.claimRewards(addr1);
            }).to.callMocks({
                func: chessSchedule.mock.mint.withArgs(addr1, balance1),
            });
        });

        it("Should calculate rewards with rebalance in two weeks", async function () {
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp + WEEK * 1)
                .returns(parseEther("3"));
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp + WEEK * 2)
                .returns(parseEther("5"));
            await fund.mock.getRebalanceSize.returns(1);
            await fund.mock.getRebalanceTimestamp
                .withArgs(0)
                .returns(rewardStartTimestamp + WEEK + 100);
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
            await advanceBlockAtTime(rewardStartTimestamp + WEEK * 2 + 100);

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
            await fund.mock.trancheTransferFrom.returns();
            await setAutomine(false);
            await staking.deposit(TRANCHE_A, deposit1, 0);
            await staking.deposit(TRANCHE_A, deposit2, 0);
            await staking.deposit(TRANCHE_A, deposit3, 0);
            await advanceBlockAtTime(rewardStartTimestamp + 100);
            await setAutomine(true);

            await advanceBlockAtTime(rewardStartTimestamp + 500);
            const { rewards1, rewards2 } = rewardsAfterDoublingTotal(100, 500);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should calculate rewards after each rebalance", async function () {
            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(rewardStartTimestamp + 100);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(rewardStartTimestamp + 400);
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
            await advanceBlockAtTime(rewardStartTimestamp + 1000);

            const rewardVersion0 = rate1.mul(100);
            const rewardVersion1 = rate1.div(2).mul(300); // Half (2/4) rate1 after the first rebalance
            const rewardVersion2 = rate1.div(5).mul(600); // One-fifth (3/15) rate1 after the first rebalance
            const expectedRewards = rewardVersion0.add(rewardVersion1).add(rewardVersion2);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(expectedRewards);
        });

        it("Should be able to handle zero total supplies between two rebalances", async function () {
            // Withdraw all Token M and A (in a single block to make rewards calculation easy)
            await fund.mock.trancheTransfer.returns();
            await fund.mock.trancheTransferFrom.returns();
            await setAutomine(false);
            await staking.withdraw(TRANCHE_M, USER1_M, 0);
            await staking.withdraw(TRANCHE_A, USER1_A, 0);
            await staking.connect(user2).withdraw(TRANCHE_M, USER2_M, 0);
            await staking.connect(user2).withdraw(TRANCHE_A, USER2_A, 0);
            await advanceBlockAtTime(rewardStartTimestamp + 100);
            await setAutomine(true);
            // Rewards before the withdrawals
            let user1Rewards = rate1.mul(100);
            let user2Rewards = rate2.mul(100);

            // Rebalance any Token B to zero in the first rebalance.
            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(rewardStartTimestamp + 400);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(rewardStartTimestamp + 1000);
            await fund.mock.doRebalance.withArgs(0, 0, TOTAL_B, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, USER1_B, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, USER2_B, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, 0, 1).returns(0, 0, 0);
            // Add rewards till the first rebalance
            user1Rewards = user1Rewards.add(parseEther("1").mul(300).mul(USER1_B).div(TOTAL_B));
            user2Rewards = user2Rewards.add(parseEther("1").mul(300).mul(USER2_B).div(TOTAL_B));

            // User1 deposit some Token M
            await setNextBlockTime(rewardStartTimestamp + 2000);
            await staking.deposit(TRANCHE_M, parseEther("1"), 2);

            // User2 deposit some Token M
            await setNextBlockTime(rewardStartTimestamp + 3500);
            await staking.connect(user2).deposit(TRANCHE_M, parseEther("1"), 2);
            // Add rewards before user2's deposit
            user1Rewards = user1Rewards.add(parseEther("1").mul(1500));

            await advanceBlockAtTime(rewardStartTimestamp + 5600);
            // The two users evenly split rewards after user2's deposit
            user1Rewards = user1Rewards.add(parseEther("0.5").mul(2100));
            user2Rewards = user2Rewards.add(parseEther("0.5").mul(2100));
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(user1Rewards);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(user2Rewards);
        });

        it("Should calculate rewards on refreshBalance()", async function () {
            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(rewardStartTimestamp + 100);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(rewardStartTimestamp + 300);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 1)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 0)
                .returns(USER1_M, USER1_A, USER1_B);
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 1)
                .returns(USER1_M, USER1_A, USER1_B);
            await advanceBlockAtTime(rewardStartTimestamp + 1000);
            expect(await staking.callStatic.claimableRewards(addr1)).to.equal(rate1.mul(1000));

            await setNextBlockTime(rewardStartTimestamp + 1200);
            await staking.refreshBalance(addr1, 1);
            expect(await staking.callStatic.claimableRewards(addr1)).to.equal(rate1.mul(1200));

            await setNextBlockTime(rewardStartTimestamp + 1500);
            await staking.refreshBalance(addr1, 1);
            expect(await staking.callStatic.claimableRewards(addr1)).to.equal(rate1.mul(1500));
        });

        it("Should calculate rewards according to boosted working balance", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([100, checkpointTimestamp + WEEK * 100]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await setNextBlockTime(rewardStartTimestamp + 100);
            await staking.syncWithVotingEscrow(addr1);

            await advanceBlockAtTime(rewardStartTimestamp + 300);
            const rate1AfterSync = parseEther("1")
                .mul(USER1_WORKING_BALANCE)
                .div(TOTAL_WEIGHT.sub(USER1_WEIGHT).add(USER1_WORKING_BALANCE));
            const reward1 = rate1.mul(100).add(rate1AfterSync.mul(200));
            const reward2 = parseEther("1").mul(300).sub(reward1);
            expect(await staking.callStatic.claimableRewards(addr1)).to.equal(reward1);
            expect(await staking.callStatic.claimableRewards(addr2)).to.equal(reward2);
        });

        it("Should calculate boosted rewards until the next rebalance", async function () {
            await votingEscrow.mock.getLockedBalance
                .withArgs(addr1)
                .returns([100, checkpointTimestamp + WEEK * 100]);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await setNextBlockTime(rewardStartTimestamp + 100);
            await staking.syncWithVotingEscrow(addr1);

            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(rewardStartTimestamp + 300);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(rewardStartTimestamp + 600);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 0)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(TOTAL_M, TOTAL_A, TOTAL_B, 1)
                .returns(TOTAL_M, TOTAL_A, TOTAL_B);
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 0)
                .returns(USER1_M, USER1_A, USER1_B);
            await fund.mock.doRebalance
                .withArgs(USER1_M, USER1_A, USER1_B, 1)
                .returns(USER1_M, USER1_A, USER1_B);
            await fund.mock.doRebalance
                .withArgs(USER2_M, USER2_A, USER2_B, 0)
                .returns(USER2_M, USER2_A, USER2_B);
            await fund.mock.doRebalance
                .withArgs(USER2_M, USER2_A, USER2_B, 1)
                .returns(USER2_M, USER2_A, USER2_B);

            await advanceBlockAtTime(rewardStartTimestamp + 1000);
            const rate1AfterSync = parseEther("1")
                .mul(USER1_WORKING_BALANCE)
                .div(TOTAL_WEIGHT.sub(USER1_WEIGHT).add(USER1_WORKING_BALANCE));
            // Boosting takes effect from time 100 to 300
            const reward1 = rate1.mul(800).add(rate1AfterSync.mul(200));
            const reward2 = parseEther("1").mul(1000).sub(reward1);
            expect(await staking.callStatic.claimableRewards(addr1)).to.equal(reward1);
            expect(await staking.callStatic.claimableRewards(addr2)).to.equal(reward2);
        });
    });
});
