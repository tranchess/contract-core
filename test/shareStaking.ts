import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
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
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
    setAutomine,
} from "./utils";

export const REWARD_WEIGHT_Q = 3;
export const REWARD_WEIGHT_B = 2;
export const REWARD_WEIGHT_R = 1;
export const MAX_BOOSTING_FACTOR = parseEther("3");
export const SPLIT_RATIO = parseEther("100");

export function boostedWorkingBalance(
    amountQ: BigNumber,
    amountB: BigNumber,
    amountR: BigNumber,
    weightedSupply: BigNumber,
    veBalance: BigNumber,
    veTotalSupply: BigNumber
): BigNumber {
    const e18 = parseEther("1");
    const weightedBalance = amountQ
        .mul(SPLIT_RATIO)
        .mul(REWARD_WEIGHT_Q)
        .div(e18)
        .add(amountB.mul(REWARD_WEIGHT_B))
        .add(amountR.mul(REWARD_WEIGHT_R))
        .div(REWARD_WEIGHT_Q);
    const upperBoundBalance = weightedBalance.mul(MAX_BOOSTING_FACTOR).div(e18);
    const boostedBalance = weightedBalance.add(
        weightedSupply.mul(veBalance).div(veTotalSupply).mul(MAX_BOOSTING_FACTOR.sub(e18)).div(e18)
    );
    return upperBoundBalance.lt(boostedBalance) ? upperBoundBalance : boostedBalance;
}

// Initial balance:
// User 1: 400 Q + 24000 B + 36000 R
// User 2:         36000 B + 24000 R
// Reward weight:
// User 1: 400   + 160   + 120   = 680
// User 2:         240   +  80   = 320
// Total : 400   + 400   + 200   = 1000
const USER1_Q = parseEther("400");
const USER1_B = parseEther("24000");
const USER1_R = parseEther("36000");
const USER2_Q = parseEther("0");
const USER2_B = parseEther("36000");
const USER2_R = parseEther("24000");
const TOTAL_Q = USER1_Q.add(USER2_Q);
const TOTAL_B = USER1_B.add(USER2_B);
const TOTAL_R = USER1_R.add(USER2_R);
const USER1_WEIGHT = USER1_Q.mul(SPLIT_RATIO)
    .mul(REWARD_WEIGHT_Q)
    .div(parseEther("1"))
    .add(USER1_B.mul(REWARD_WEIGHT_B))
    .add(USER1_R.mul(REWARD_WEIGHT_R))
    .div(REWARD_WEIGHT_Q);
const USER2_WEIGHT = USER2_Q.mul(SPLIT_RATIO)
    .mul(REWARD_WEIGHT_Q)
    .div(parseEther("1"))
    .add(USER2_B.mul(REWARD_WEIGHT_B))
    .add(USER2_R.mul(REWARD_WEIGHT_R))
    .div(REWARD_WEIGHT_Q);
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

const USER1_WORKING_BALANCE = boostedWorkingBalance(
    USER1_Q,
    USER1_B,
    USER1_R,
    TOTAL_WEIGHT,
    USER1_VE,
    TOTAL_VE
);
const USER2_WORKING_BALANCE = boostedWorkingBalance(
    USER2_Q,
    USER2_B,
    USER2_R,
    TOTAL_WEIGHT,
    USER2_VE,
    TOTAL_VE
);
const WORKING_SUPPLY = USER1_WORKING_BALANCE.add(USER2_WORKING_BALANCE);

describe("ShareStaking", function () {
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
        const startTimestamp = Math.floor(startEpoch / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;

        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.splitRatio.returns(SPLIT_RATIO);

        const chessSchedule = await deployMockForName(owner, "IChessSchedule");
        await chessSchedule.mock.getRate.returns(0);

        const chessController = await deployMockForName(owner, "IChessController");
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(1);

        const ShareStaking = await ethers.getContractFactory("ShareStaking");
        const staking = await ShareStaking.connect(owner).deploy(
            fund.address,
            chessSchedule.address,
            chessController.address,
            votingEscrow.address,
            startTimestamp,
            0
        );
        await advanceBlockAtTime(startTimestamp);

        // Deposit initial shares
        await fund.mock.trancheTransferFrom.returns();
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_Q, staking.address).returns(0);
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_B, staking.address).returns(0);
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_R, staking.address).returns(0);
        await staking.connect(user1).deposit(TRANCHE_Q, USER1_Q, user1.address, 0);
        await staking.connect(user1).deposit(TRANCHE_B, USER1_B, user1.address, 0);
        await staking.connect(user1).deposit(TRANCHE_R, USER1_R, user1.address, 0);
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_Q, staking.address).returns(USER1_Q);
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_B, staking.address).returns(USER1_B);
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_R, staking.address).returns(USER1_R);
        await staking.connect(user2).deposit(TRANCHE_Q, USER2_Q, user2.address, 0);
        await staking.connect(user2).deposit(TRANCHE_B, USER2_B, user2.address, 0);
        await staking.connect(user2).deposit(TRANCHE_R, USER2_R, user2.address, 0);
        const checkpointTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_Q, staking.address).returns(TOTAL_Q);
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_B, staking.address).returns(TOTAL_B);
        await fund.mock.trancheBalanceOf.withArgs(TRANCHE_R, staking.address).returns(TOTAL_R);
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

    describe("initial checkpoint", function () {
        let testStaking: Contract;
        const delay = DAY;
        beforeEach(async function () {
            const ShareStaking = await ethers.getContractFactory("ShareStaking");
            const startEpoch = (await ethers.provider.getBlock("latest")).timestamp;
            const startTimestamp = Math.floor(startEpoch / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
            testStaking = await ShareStaking.connect(owner).deploy(
                fund.address,
                chessSchedule.address,
                chessController.address,
                votingEscrow.address,
                startTimestamp,
                delay
            );
            await chessSchedule.mock.getRate.withArgs(startTimestamp).returns(parseEther("1"));
            await advanceBlockAtTime(startTimestamp + DAY);
        });

        it("Should initialize with adjusted initial rate", async function () {
            const rate = parseEther("1")
                .mul(parseEther("1"))
                .mul(WEEK)
                .div(WEEK - delay)
                .div(parseEther("1"));
            await testStaking.syncWithVotingEscrow(addr1);
            expect(await testStaking.getRate()).to.equal(rate);
        });
    });

    describe("deposit()", function () {
        it("Should revert if version mismatches the fund version", async function () {
            await fund.mock.trancheBalanceOf
                .withArgs(TRANCHE_Q, staking.address)
                .returns(TOTAL_Q.add(10000));
            // The version check is only reached under these abnormal mock function returns.
            await fund.mock.getRebalanceTimestamp.returns(checkpointTimestamp + 1000);
            await fund.mock.doRebalance.returns(0, 0, 0);
            await expect(staking.deposit(TRANCHE_Q, 10000, addr1, 1)).to.be.revertedWith(
                "Invalid version"
            );
        });

        it("Should transfer shares and update balance", async function () {
            await expect(() => staking.deposit(TRANCHE_Q, 10000, addr1, 0)).to.callMocks({
                func: fund.mock.trancheTransferFrom.withArgs(
                    TRANCHE_Q,
                    addr1,
                    staking.address,
                    10000,
                    0
                ),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(USER1_Q.add(10000));
            expect(await staking.totalSupply(TRANCHE_Q)).to.equal(TOTAL_Q.add(10000));
            await expect(() => staking.deposit(TRANCHE_B, 1000, addr1, 0)).to.callMocks({
                func: fund.mock.trancheTransferFrom.withArgs(
                    TRANCHE_B,
                    addr1,
                    staking.address,
                    1000,
                    0
                ),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.add(1000));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.add(1000));
            await expect(() => staking.deposit(TRANCHE_R, 100, addr1, 0)).to.callMocks({
                func: fund.mock.trancheTransferFrom.withArgs(
                    TRANCHE_R,
                    addr1,
                    staking.address,
                    100,
                    0
                ),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(USER1_R.add(100));
            expect(await staking.totalSupply(TRANCHE_R)).to.equal(TOTAL_R.add(100));
        });

        it("Should emit an event", async function () {
            await fund.mock.trancheTransferFrom.returns();
            await expect(staking.deposit(TRANCHE_Q, 10000, addr1, 0))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_Q, addr1, 10000);
            await expect(staking.deposit(TRANCHE_B, 1000, addr1, 0))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_B, addr1, 1000);
            await expect(staking.deposit(TRANCHE_R, 100, addr1, 0))
                .to.emit(staking, "Deposited")
                .withArgs(TRANCHE_R, addr1, 100);
        });
    });

    describe("withdraw()", function () {
        it("Should transfer shares and update balance", async function () {
            await expect(() => staking.withdraw(TRANCHE_Q, 1000, 0)).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_Q, addr1, 1000, 0),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(USER1_Q.sub(1000));
            expect(await staking.totalSupply(TRANCHE_Q)).to.equal(TOTAL_Q.sub(1000));
            await expect(() => staking.withdraw(TRANCHE_B, 100, 0)).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr1, 100, 0),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(USER1_B.sub(100));
            expect(await staking.totalSupply(TRANCHE_B)).to.equal(TOTAL_B.sub(100));
            await expect(() => staking.withdraw(TRANCHE_R, 10, 0)).to.callMocks({
                func: fund.mock.trancheTransfer.withArgs(TRANCHE_R, addr1, 10, 0),
            });
            expect(await staking.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(USER1_R.sub(10));
            expect(await staking.totalSupply(TRANCHE_R)).to.equal(TOTAL_R.sub(10));
        });

        it("Should revert if balance is not enough", async function () {
            await expect(staking.withdraw(TRANCHE_Q, USER1_Q.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
            await expect(staking.withdraw(TRANCHE_B, USER1_B.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
            await expect(staking.withdraw(TRANCHE_R, USER1_R.add(1), 0)).to.be.revertedWith(
                "Insufficient balance to withdraw"
            );
        });

        it("Should emit an event", async function () {
            await fund.mock.trancheTransfer.returns();
            await expect(staking.withdraw(TRANCHE_Q, 10000, 0))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_Q, addr1, 10000);
            await expect(staking.withdraw(TRANCHE_B, 1000, 0))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_B, addr1, 1000);
            await expect(staking.withdraw(TRANCHE_R, 100, 0))
                .to.emit(staking, "Withdrawn")
                .withArgs(TRANCHE_R, addr1, 100);
        });
    });

    describe("weightedBalance()", function () {
        it("Should calculate weighted balance", async function () {
            expect(await staking.weightedBalance(1000, 0, 0, SPLIT_RATIO)).to.equal(
                SPLIT_RATIO.mul(1000).div(parseEther("1"))
            );
            expect(await staking.weightedBalance(0, 1000, 0, SPLIT_RATIO)).to.equal(
                BigNumber.from(1000 * REWARD_WEIGHT_B).div(REWARD_WEIGHT_Q)
            );
            expect(await staking.weightedBalance(0, 0, 1000, SPLIT_RATIO)).to.equal(
                BigNumber.from(1000 * REWARD_WEIGHT_R).div(REWARD_WEIGHT_Q)
            );
        });

        it("Should return the weighted value", async function () {
            const q = 1000000;
            const b = 10000;
            const r = 100;
            expect(await staking.weightedBalance(q, b, r, SPLIT_RATIO)).to.equal(
                SPLIT_RATIO.mul(q)
                    .mul(REWARD_WEIGHT_Q)
                    .div(parseEther("1"))
                    .add(REWARD_WEIGHT_B * b)
                    .add(REWARD_WEIGHT_R * r)
                    .div(REWARD_WEIGHT_Q)
            );
        });

        it("Should round down weighted balance", async function () {
            // Assume weights of (Q, B, R) are (6r, 4, 2)
            expect(await staking.weightedBalance(0, 2, 0, SPLIT_RATIO)).to.equal(1);
            expect(await staking.weightedBalance(0, 0, 2, SPLIT_RATIO)).to.equal(0);
            expect(await staking.weightedBalance(0, 2, 2, SPLIT_RATIO)).to.equal(2);
        });
    });

    describe("syncWithVotingEscrow()", function () {
        beforeEach(async function () {
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.balanceOf.withArgs(addr2).returns(USER2_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
        });

        it("Should update everything the first time", async function () {
            await staking.syncWithVotingEscrow(addr1);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await staking.workingSupply()).to.equal(USER1_WORKING_BALANCE.add(USER2_WEIGHT));

            await staking.syncWithVotingEscrow(addr2);
            expect(await staking.workingBalanceOf(addr2)).to.equal(USER2_WORKING_BALANCE);
            expect(await staking.workingSupply()).to.equal(WORKING_SUPPLY);
        });

        it("Should still update working balance with no other action taken", async function () {
            await staking.syncWithVotingEscrow(addr1);
            await fund.mock.trancheTransferFrom.returns();
            await votingEscrow.mock.balanceOf.withArgs(addr2).returns(0);
            await staking
                .connect(user2)
                .deposit(TRANCHE_Q, TOTAL_WEIGHT.mul(parseEther("1")).div(SPLIT_RATIO), addr2, 0); // Weighted total supply doubles
            await staking.syncWithVotingEscrow(addr1);
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_Q,
                    USER1_B,
                    USER1_R,
                    TOTAL_WEIGHT.mul(2),
                    USER1_VE,
                    TOTAL_VE
                )
            );
            expect(await staking.workingSupply()).to.equal(
                workingBalance.add(USER2_WEIGHT).add(TOTAL_WEIGHT)
            );
        });

        it("Should update ve proportion if locked amount changed/unlock time extended", async function () {
            await staking.syncWithVotingEscrow(addr1);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE.mul(2));
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE.mul(5));
            await staking.syncWithVotingEscrow(addr1);
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_Q,
                    USER1_B,
                    USER1_R,
                    TOTAL_WEIGHT,
                    USER1_VE.mul(2),
                    TOTAL_VE.mul(5)
                )
            );
            expect(await staking.workingSupply()).to.equal(workingBalance.add(USER2_WEIGHT));
        });
    });

    describe("Working balance update due to balance change", function () {
        beforeEach(async function () {
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
        });

        it("Should update working balance on deposit()", async function () {
            await fund.mock.trancheTransferFrom.returns();
            await staking.deposit(TRANCHE_Q, USER1_Q, addr1, 0);
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_Q.add(USER1_Q),
                    USER1_B,
                    USER1_R,
                    TOTAL_WEIGHT.add(USER1_Q.mul(SPLIT_RATIO).div(parseEther("1"))),
                    USER1_VE,
                    TOTAL_VE
                )
            );
            expect(await staking.workingSupply()).to.equal(workingBalance.add(USER2_WEIGHT));
        });

        it("Should update working balance on withdraw()", async function () {
            await fund.mock.trancheTransfer.returns();
            await staking.withdraw(TRANCHE_Q, USER1_Q, 0);
            const workingBalance = await staking.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    BigNumber.from(0),
                    USER1_B,
                    USER1_R,
                    TOTAL_WEIGHT.sub(USER1_Q.mul(SPLIT_RATIO).div(parseEther("1"))),
                    USER1_VE,
                    TOTAL_VE
                )
            );
            expect(await staking.workingSupply()).to.equal(workingBalance.add(USER2_WEIGHT));
        });

        it("Should update working balance when reaching max boosting power of QUEEN", async function () {
            await fund.mock.trancheTransfer.returns();
            await fund.mock.trancheTransferFrom.returns();
            await staking.connect(user2).deposit(TRANCHE_B, USER1_B, addr2, 0); // To keep weighted supply unchanged
            await staking.withdraw(TRANCHE_B, USER1_B, 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(
                boostedWorkingBalance(
                    USER1_Q,
                    BigNumber.from(0),
                    USER1_R,
                    TOTAL_WEIGHT,
                    USER1_VE,
                    TOTAL_VE
                )
            );

            await staking.connect(user2).deposit(TRANCHE_R, USER1_R, addr2, 0); // To keep weighted supply unchanged
            await staking.withdraw(TRANCHE_R, USER1_R, 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(
                boostedWorkingBalance(
                    USER1_Q,
                    BigNumber.from(0),
                    BigNumber.from(0),
                    TOTAL_WEIGHT,
                    USER1_VE,
                    TOTAL_VE
                )
            );

            await staking.connect(user2).deposit(TRANCHE_Q, USER1_Q.div(2), addr2, 0); // To keep weighted supply unchanged
            await staking.withdraw(TRANCHE_Q, USER1_Q.div(2), 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(
                boostedWorkingBalance(
                    USER1_Q.div(2),
                    BigNumber.from(0),
                    BigNumber.from(0),
                    TOTAL_WEIGHT,
                    USER1_VE,
                    TOTAL_VE
                )
            );
        });

        it("Should not update working balance on refreshBalance()", async function () {
            await staking.refreshBalance(addr1, 0);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WEIGHT);
            expect(await staking.workingSupply()).to.equal(USER1_WEIGHT.add(USER2_WEIGHT));
        });

        it("Should update working balance on claimRewards()", async function () {
            await chessSchedule.mock.mint.returns();
            await staking.claimRewards(addr1);
            expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await staking.workingSupply()).to.equal(USER1_WORKING_BALANCE.add(USER2_WEIGHT));
        });

        it("Should reset working balance without boosting after rebalance", async function () {
            await fund.mock.getRebalanceSize.returns(1);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 100);
            await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
            await advanceBlockAtTime(checkpointTimestamp + 100);
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0)
                .returns(TOTAL_Q, TOTAL_B, TOTAL_R);
            await fund.mock.doRebalance
                .withArgs(USER1_Q, USER1_B, USER1_R, 0)
                .returns(USER1_Q, USER1_B, USER1_R);

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
                    .withArgs(USER1_Q, USER1_B, USER1_R, 0, 3)
                    .returns(123, 456, 789);
                expect(await staking.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(123);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(456);
                expect(await staking.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(789);
            });

            it("Should not perform rebalance if the original balance is zero (for QUEEN)", async function () {
                await fund.mock.trancheTransfer.returns();
                await staking.withdraw(TRANCHE_Q, USER1_Q, 0);
                await staking.withdraw(TRANCHE_B, USER1_B, 0);
                await staking.withdraw(TRANCHE_R, USER1_R, 0);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for BISHOP)", async function () {
                await fund.mock.trancheTransfer.returns();
                await staking.withdraw(TRANCHE_B, USER1_B, 0);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(0);
            });

            it("Should not perform rebalance if the original balance is zero (for ROOK)", async function () {
                await fund.mock.trancheTransfer.returns();
                await staking.withdraw(TRANCHE_R, USER1_R, 0);
                await fund.mock.getRebalanceSize.returns(3);
                expect(await staking.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(0);
            });
        });

        describe("totalSupply()", function () {
            it("Should return rebalanced total supply", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.batchRebalance
                    .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0, 2)
                    .returns(123, 456, 789);
                expect(await staking.totalSupply(TRANCHE_Q)).to.equal(123);
                expect(await staking.totalSupply(TRANCHE_B)).to.equal(456);
                expect(await staking.totalSupply(TRANCHE_R)).to.equal(789);
            });
        });

        describe("workingSupply()", function () {
            it("Should return rebalanced working supply (without boosting)", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.batchRebalance
                    .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0, 2)
                    .returns(TOTAL_Q.mul(3), TOTAL_B.mul(3), TOTAL_R.mul(3));
                expect(await staking.workingSupply()).to.equal(TOTAL_WEIGHT.mul(3));
            });
        });

        describe("workingBalanceOf()", function () {
            it("Should return rebalanced working balance (without boosting)", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.batchRebalance
                    .withArgs(USER1_Q, USER1_B, USER1_R, 0, 2)
                    .returns(USER1_Q.mul(8), USER1_B.mul(8), USER1_R.mul(8));
                expect(await staking.workingBalanceOf(addr1)).to.equal(USER1_WEIGHT.mul(8));
            });
        });

        describe("refreshBalance()", function () {
            it("Non-zero targetVersion", async function () {
                await fund.mock.getRebalanceSize.returns(3);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.getRebalanceTimestamp.withArgs(1).returns(checkpointTimestamp + 2);
                await fund.mock.getRebalanceTimestamp.withArgs(2).returns(checkpointTimestamp + 3);
                await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(2).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(3).returns(SPLIT_RATIO);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(addr1, 1)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0),
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
                        func: fund.mock.doRebalance.withArgs(USER1_Q, USER1_B, USER1_R, 0),
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
                expect(await staking.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(12300);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(45600);
                expect(await staking.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(78900);
            });

            it("Zero targetVersion", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.getRebalanceTimestamp.withArgs(1).returns(checkpointTimestamp + 2);
                await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(2).returns(SPLIT_RATIO);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(addr1, 0)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0),
                        rets: [10000, 1000, 100],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(10000, 1000, 100, 1),
                        rets: [20000, 2000, 200],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(USER1_Q, USER1_B, USER1_R, 0),
                        rets: [123, 456, 789],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(123, 456, 789, 1),
                        rets: [1230, 4560, 7890],
                    }
                );
                expect(await staking.balanceVersion(addr1)).to.equal(2);
                expect(await staking.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(1230);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(4560);
                expect(await staking.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(7890);
            });

            it("Should make no change if targetVersion is older", async function () {
                await fund.mock.getRebalanceSize.returns(2);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.getRebalanceTimestamp.withArgs(1).returns(checkpointTimestamp + 2);
                await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(2).returns(SPLIT_RATIO);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(addr1, 2)).to.callMocks(
                    {
                        func: fund.mock.doRebalance.withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0),
                        rets: [10000, 1000, 100],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(10000, 1000, 100, 1),
                        rets: [20000, 2000, 200],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(USER1_Q, USER1_B, USER1_R, 0),
                        rets: [123, 456, 789],
                    },
                    {
                        func: fund.mock.doRebalance.withArgs(123, 456, 789, 1),
                        rets: [1230, 4560, 7890],
                    }
                );

                await staking.refreshBalance(addr1, 1);
                expect(await staking.trancheBalanceOf(TRANCHE_Q, addr1)).to.equal(1230);
                expect(await staking.trancheBalanceOf(TRANCHE_B, addr1)).to.equal(4560);
                expect(await staking.trancheBalanceOf(TRANCHE_R, addr1)).to.equal(7890);
            });

            it("Should rebalance zero balance", async function () {
                await fund.mock.getRebalanceSize.returns(1);
                await fund.mock.getRebalanceTimestamp.withArgs(0).returns(checkpointTimestamp + 1);
                await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
                await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
                await advanceBlockAtTime(checkpointTimestamp + 100);
                await expect(() => staking.refreshBalance(owner.address, 1)).to.callMocks({
                    func: fund.mock.doRebalance.withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0),
                    rets: [10000, 1000, 100],
                });
                expect(await staking.trancheBalanceOf(TRANCHE_Q, owner.address)).to.equal(0);
                expect(await staking.trancheBalanceOf(TRANCHE_B, owner.address)).to.equal(0);
                expect(await staking.trancheBalanceOf(TRANCHE_R, owner.address)).to.equal(0);
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
            // Deposit some BISHOP to double the total reward weight
            await fund.mock.trancheTransferFrom.returns();
            await setNextBlockTime(rewardStartTimestamp + 100);
            await staking.deposit(
                TRANCHE_B,
                TOTAL_WEIGHT.mul(REWARD_WEIGHT_Q).div(REWARD_WEIGHT_B),
                addr1,
                0
            );

            await advanceBlockAtTime(rewardStartTimestamp + 500);
            const { rewards1, rewards2 } = rewardsAfterDoublingTotal(100, 500);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(rewards1);
            expect(await staking.callStatic["claimableRewards"](addr2)).to.equal(rewards2);
        });

        it("Should make a checkpoint on withdraw()", async function () {
            // Withdraw some QUEEN to reduce 20% of the total reward weight,
            // assuming balance is enough
            await fund.mock.trancheTransfer.returns();
            await setNextBlockTime(rewardStartTimestamp + 200);
            await staking.withdraw(
                TRANCHE_Q,
                TOTAL_WEIGHT.mul(parseEther("1")).div(5).div(SPLIT_RATIO),
                0
            );

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
            await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO.mul(2));
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0)
                .returns(TOTAL_Q.mul(2), TOTAL_B.mul(4), TOTAL_R.mul(4));
            await fund.mock.doRebalance
                .withArgs(USER1_Q, USER1_B, USER1_R, 0)
                .returns(USER1_Q, USER1_B.mul(2), USER1_R.mul(2));
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
            // Deposit some BISHOP to double the total reward weight, in three transactions
            const totalDeposit = TOTAL_WEIGHT.mul(REWARD_WEIGHT_Q).div(REWARD_WEIGHT_B);
            const deposit1 = totalDeposit.div(4);
            const deposit2 = totalDeposit.div(3);
            const deposit3 = totalDeposit.sub(deposit1).sub(deposit2);
            await fund.mock.trancheTransferFrom.returns();
            await setAutomine(false);
            await staking.deposit(TRANCHE_B, deposit1, addr1, 0);
            await fund.mock.trancheBalanceOf
                .withArgs(TRANCHE_B, staking.address)
                .returns(TOTAL_B.add(deposit1));
            await staking.deposit(TRANCHE_B, deposit2, addr1, 0);
            await fund.mock.trancheBalanceOf
                .withArgs(TRANCHE_B, staking.address)
                .returns(TOTAL_B.add(deposit1).add(deposit2));
            await staking.deposit(TRANCHE_B, deposit3, addr1, 0);
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
            await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(2).returns(SPLIT_RATIO);
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0)
                .returns(TOTAL_Q.mul(4), TOTAL_B.mul(4), TOTAL_R.mul(4));
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q.mul(4), TOTAL_B.mul(4), TOTAL_R.mul(4), 1)
                .returns(TOTAL_Q.mul(15), TOTAL_B.mul(15), TOTAL_R.mul(15));
            await fund.mock.doRebalance
                .withArgs(USER1_Q, USER1_B, USER1_R, 0)
                .returns(USER1_Q.mul(2), USER1_B.mul(2), USER1_R.mul(2));
            await fund.mock.doRebalance
                .withArgs(USER1_Q.mul(2), USER1_B.mul(2), USER1_R.mul(2), 1)
                .returns(USER1_Q.mul(3), USER1_B.mul(3), USER1_R.mul(3));
            await advanceBlockAtTime(rewardStartTimestamp + 1000);

            const rewardVersion0 = rate1.mul(100);
            const rewardVersion1 = rate1.div(2).mul(300); // Half (2/4) rate1 after the first rebalance
            const rewardVersion2 = rate1.div(5).mul(600); // One-fifth (3/15) rate1 after the first rebalance
            const expectedRewards = rewardVersion0.add(rewardVersion1).add(rewardVersion2);
            expect(await staking.callStatic["claimableRewards"](addr1)).to.equal(expectedRewards);
        });

        it("Should be able to handle zero total supplies between two rebalances", async function () {
            // Withdraw all QUEEN and BISHOP (in a single block to make rewards calculation easy)
            await fund.mock.trancheTransfer.returns();
            await fund.mock.trancheTransferFrom.returns();
            await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(2).returns(SPLIT_RATIO);
            await setAutomine(false);
            await staking.withdraw(TRANCHE_Q, USER1_Q, 0);
            await staking.withdraw(TRANCHE_B, USER1_B, 0);
            await staking.connect(user2).withdraw(TRANCHE_Q, USER2_Q, 0);
            await staking.connect(user2).withdraw(TRANCHE_B, USER2_B, 0);
            await advanceBlockAtTime(rewardStartTimestamp + 100);
            await setAutomine(true);
            // Rewards before the withdrawals
            let user1Rewards = rate1.mul(100);
            let user2Rewards = rate2.mul(100);

            // Rebalance any ROOK to zero in the first rebalance.
            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(rewardStartTimestamp + 400);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(rewardStartTimestamp + 1000);
            await fund.mock.doRebalance.withArgs(0, 0, TOTAL_R, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, USER1_R, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, USER2_R, 0).returns(0, 0, 0);
            await fund.mock.doRebalance.withArgs(0, 0, 0, 1).returns(0, 0, 0);
            // Add rewards till the first rebalance
            user1Rewards = user1Rewards.add(parseEther("1").mul(300).mul(USER1_R).div(TOTAL_R));
            user2Rewards = user2Rewards.add(parseEther("1").mul(300).mul(USER2_R).div(TOTAL_R));

            // User1 deposit some QUEEN
            await setNextBlockTime(rewardStartTimestamp + 2000);
            await staking.deposit(TRANCHE_Q, parseEther("1"), addr1, 2);

            // User2 deposit some QUEEN
            await fund.mock.trancheBalanceOf
                .withArgs(TRANCHE_Q, staking.address)
                .returns(TOTAL_Q.add(parseEther("1")));
            await setNextBlockTime(rewardStartTimestamp + 3500);
            await staking.connect(user2).deposit(TRANCHE_Q, parseEther("1"), addr2, 2);
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
            await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(2).returns(SPLIT_RATIO);
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0)
                .returns(TOTAL_Q, TOTAL_B, TOTAL_R);
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 1)
                .returns(TOTAL_Q, TOTAL_B, TOTAL_R);
            await fund.mock.doRebalance
                .withArgs(USER1_Q, USER1_B, USER1_R, 0)
                .returns(USER1_Q, USER1_B, USER1_R);
            await fund.mock.doRebalance
                .withArgs(USER1_Q, USER1_B, USER1_R, 1)
                .returns(USER1_Q, USER1_B, USER1_R);
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
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await setNextBlockTime(rewardStartTimestamp + 100);
            await staking.syncWithVotingEscrow(addr1);

            await fund.mock.getRebalanceSize.returns(2);
            await fund.mock.getRebalanceTimestamp.withArgs(0).returns(rewardStartTimestamp + 300);
            await fund.mock.getRebalanceTimestamp.withArgs(1).returns(rewardStartTimestamp + 600);
            await fund.mock.historicalSplitRatio.withArgs(0).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(1).returns(SPLIT_RATIO);
            await fund.mock.historicalSplitRatio.withArgs(2).returns(SPLIT_RATIO);
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 0)
                .returns(TOTAL_Q, TOTAL_B, TOTAL_R);
            await fund.mock.doRebalance
                .withArgs(TOTAL_Q, TOTAL_B, TOTAL_R, 1)
                .returns(TOTAL_Q, TOTAL_B, TOTAL_R);
            await fund.mock.doRebalance
                .withArgs(USER1_Q, USER1_B, USER1_R, 0)
                .returns(USER1_Q, USER1_B, USER1_R);
            await fund.mock.doRebalance
                .withArgs(USER1_Q, USER1_B, USER1_R, 1)
                .returns(USER1_Q, USER1_B, USER1_R);
            await fund.mock.doRebalance
                .withArgs(USER2_Q, USER2_B, USER2_R, 0)
                .returns(USER2_Q, USER2_B, USER2_R);
            await fund.mock.doRebalance
                .withArgs(USER2_Q, USER2_B, USER2_R, 1)
                .returns(USER2_Q, USER2_B, USER2_R);

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
