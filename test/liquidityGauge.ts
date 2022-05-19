import { expect } from "chai";
import { BigNumber, constants, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseUsdc = (value: string) => parseUnits(value, 6);
import { deployMockForName } from "./mock";
import {
    TRANCHE_Q,
    TRANCHE_B,
    TRANCHE_R,
    WEEK,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
    SETTLEMENT_TIME,
} from "./utils";

export const MAX_BOOSTING_FACTOR = parseEther("3");

export function boostedWorkingBalance(
    balance: BigNumber,
    totalSupply: BigNumber,
    veBalance: BigNumber,
    veTotalSupply: BigNumber
): BigNumber {
    const e18 = parseEther("1");
    const upperBoundBalance = balance.mul(MAX_BOOSTING_FACTOR).div(e18);
    const boostedBalance = balance.add(
        totalSupply.mul(veBalance).div(veTotalSupply).mul(MAX_BOOSTING_FACTOR.sub(e18)).div(e18)
    );
    return upperBoundBalance.lt(boostedBalance) ? upperBoundBalance : boostedBalance;
}

// Initial balance:
// User 1: 180 LP
// User 2: 220 LP
const USER1_LP = parseEther("180");
const USER2_LP = parseEther("220");
const TOTAL_LP = USER1_LP.add(USER2_LP);

// veCHESS proportion:
// User 1: 30%
// User 2: 70%
// Boosted liquidityGauge weight:
// User 1: 180 + 400 * 30% * (3 - 1) = 420
// User 2: 220 * 3 = 660
// Total : 420 + 660 = 1080
const USER1_VE = parseEther("0.03");
const USER2_VE = parseEther("0.07");
const TOTAL_VE = USER1_VE.add(USER2_VE);

const USER1_WORKING_BALANCE = boostedWorkingBalance(USER1_LP, TOTAL_LP, USER1_VE, TOTAL_VE);
const USER2_WORKING_BALANCE = boostedWorkingBalance(USER2_LP, TOTAL_LP, USER2_VE, TOTAL_VE);
const WORKING_SUPPLY = USER1_WORKING_BALANCE.add(USER2_WORKING_BALANCE);

describe("LiquidityGauge", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly fund: MockContract;
        readonly swap: MockContract;
        readonly chessSchedule: MockContract;
        readonly votingEscrow: MockContract;
        readonly usdc: Contract;
        readonly liquidityGauge: Contract;
        readonly swapBonus: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let fund: MockContract;
    let swap: MockContract;
    let chessSchedule: MockContract;
    let votingEscrow: MockContract;
    let usdc: Contract;
    let liquidityGauge: Contract;
    let swapBonus: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        await advanceBlockAtTime(Math.ceil(startTimestamp / WEEK) * WEEK + WEEK);

        const MockToken = await ethers.getContractFactory("MockToken");
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);
        const swap = await deployMockForName(owner, "BishopStableSwap");
        await swap.mock.quoteAddress.returns(usdc.address);
        const fund = await deployMockForName(owner, "IFundV3");

        const chessSchedule = await deployMockForName(owner, "IChessSchedule");
        await chessSchedule.mock.getRate.returns(0);
        const chessController = await deployMockForName(owner, "IChessController");
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));
        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(TOTAL_VE);

        const liquidityGaugeAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 1,
        });
        const SwapBonus = await ethers.getContractFactory("SwapBonus");
        const swapBonus = await SwapBonus.connect(owner).deploy(
            liquidityGaugeAddress,
            usdc.address
        );
        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const liquidityGauge = await LiquidityGauge.connect(owner).deploy(
            "Test LP",
            "TLP",
            swap.address,
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address,
            swapBonus.address
        );

        // Deposit initial shares
        await swap.call(liquidityGauge, "mint", user1.address, USER1_LP);
        await swap.call(liquidityGauge, "mint", user2.address, USER2_LP);

        return {
            wallets: { user1, user2, owner },
            fund,
            swap,
            chessSchedule,
            votingEscrow,
            usdc,
            liquidityGauge,
            swapBonus,
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
        addr1 = user1.address;
        addr2 = user2.address;
        fund = fixtureData.fund;
        swap = fixtureData.swap;
        chessSchedule = fixtureData.chessSchedule;
        votingEscrow = fixtureData.votingEscrow;
        usdc = fixtureData.usdc;
        liquidityGauge = fixtureData.liquidityGauge;
        swapBonus = fixtureData.swapBonus;
    });

    describe("mint()", function () {
        it("Should only be called by stable swap", async function () {
            await expect(liquidityGauge.mint(addr1, 10000)).to.be.revertedWith("Only stable swap");
        });

        it("Should update balance", async function () {
            await swap.call(liquidityGauge, "mint", addr1, 10000);
            expect(await liquidityGauge.balanceOf(addr1)).to.equal(USER1_LP.add(10000));
            expect(await liquidityGauge.totalSupply()).to.equal(TOTAL_LP.add(10000));
        });

        it("Should emit an event", async function () {
            await expect(swap.call(liquidityGauge, "mint", addr1, 10000))
                .to.emit(liquidityGauge, "Transfer")
                .withArgs(constants.AddressZero, addr1, 10000);
        });
    });

    describe("burnFrom()", function () {
        it("Should only be called by stable swap", async function () {
            await expect(liquidityGauge.burnFrom(addr1, 10000)).to.be.revertedWith(
                "Only stable swap"
            );
        });

        it("Should update balance", async function () {
            await swap.call(liquidityGauge, "burnFrom", addr1, 10000);
            expect(await liquidityGauge.balanceOf(addr1)).to.equal(USER1_LP.sub(10000));
            expect(await liquidityGauge.totalSupply()).to.equal(TOTAL_LP.sub(10000));
        });

        it("Should revert if balance is not enough", async function () {
            await expect(
                swap.call(liquidityGauge, "burnFrom", addr1, USER1_LP.add(1))
            ).to.be.revertedWith("ERC20: burn amount exceeds balance");
        });

        it("Should emit an event", async function () {
            await expect(swap.call(liquidityGauge, "burnFrom", addr1, 10000))
                .to.emit(liquidityGauge, "Transfer")
                .withArgs(addr1, constants.AddressZero, 10000);
        });
    });

    describe("transfer()", function () {
        it("Should revert any transfer", async function () {
            await expect(liquidityGauge.transfer(addr2, 0)).to.be.revertedWith(
                "Transfer is not allowed"
            );
            await expect(liquidityGauge.transferFrom(addr2, addr1, 0)).to.be.revertedWith(
                "Transfer is not allowed"
            );
        });
    });

    describe("syncWithVotingEscrow()", function () {
        beforeEach(async function () {
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.balanceOf.withArgs(addr2).returns(USER2_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
        });

        it("Should update everything the first time", async function () {
            await liquidityGauge.syncWithVotingEscrow(addr1);
            expect(await liquidityGauge.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await liquidityGauge.workingSupply()).to.equal(
                USER1_WORKING_BALANCE.add(USER2_LP)
            );

            await liquidityGauge.syncWithVotingEscrow(addr2);
            expect(await liquidityGauge.workingBalanceOf(addr2)).to.equal(USER2_WORKING_BALANCE);
            expect(await liquidityGauge.workingSupply()).to.equal(WORKING_SUPPLY);
        });

        it("Should still update working balance with no other action taken", async function () {
            await liquidityGauge.syncWithVotingEscrow(addr1);
            await votingEscrow.mock.balanceOf.withArgs(addr2).returns(0);
            await swap.call(liquidityGauge, "mint", addr2, TOTAL_LP);
            await liquidityGauge.syncWithVotingEscrow(addr1);
            const workingBalance = await liquidityGauge.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(USER1_LP, TOTAL_LP.mul(2), USER1_VE, TOTAL_VE)
            );
            expect(await liquidityGauge.workingSupply()).to.equal(
                workingBalance.add(USER2_LP).add(TOTAL_LP)
            );
        });

        it("Should update ve proportion if locked amount changed/unlock time extended", async function () {
            await liquidityGauge.syncWithVotingEscrow(addr1);
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE.mul(2));
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE.mul(5));
            await liquidityGauge.syncWithVotingEscrow(addr1);
            const workingBalance = await liquidityGauge.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(USER1_LP, TOTAL_LP, USER1_VE.mul(2), TOTAL_VE.mul(5))
            );
            expect(await liquidityGauge.workingSupply()).to.equal(workingBalance.add(USER2_LP));
        });
    });

    describe("Working balance update due to balance change", function () {
        beforeEach(async function () {
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
        });

        it("Should update working balance on mint()", async function () {
            await swap.call(liquidityGauge, "mint", addr1, USER1_LP);
            const workingBalance = await liquidityGauge.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_LP.add(USER1_LP),
                    TOTAL_LP.add(USER1_LP),
                    USER1_VE,
                    TOTAL_VE
                )
            );
            expect(await liquidityGauge.workingSupply()).to.equal(workingBalance.add(USER2_LP));
        });

        it("Should update working balance on burnFrom()", async function () {
            await swap.call(liquidityGauge, "burnFrom", addr1, USER1_LP.div(10));
            const workingBalance = await liquidityGauge.workingBalanceOf(addr1);
            expect(workingBalance).to.equal(
                boostedWorkingBalance(
                    USER1_LP.sub(USER1_LP.div(10)),
                    TOTAL_LP.sub(USER1_LP.div(10)),
                    USER1_VE,
                    TOTAL_VE
                )
            );
            expect(await liquidityGauge.workingSupply()).to.equal(workingBalance.add(USER2_LP));
        });

        it("Should update working balance on claimRewards()", async function () {
            expect(await liquidityGauge.workingBalanceOf(addr1)).to.equal(USER1_LP);
            await chessSchedule.mock.mint.returns();
            await liquidityGauge.claimRewards(addr1);
            expect(await liquidityGauge.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await liquidityGauge.workingSupply()).to.equal(
                USER1_WORKING_BALANCE.add(USER2_LP)
            );
        });
    });

    describe("Chess checkpoint", function () {
        let rewardStartTimestamp: number; // Reward rate becomes non-zero at this timestamp.
        let rate1: BigNumber;
        let rate2: BigNumber;

        beforeEach(async function () {
            const t = (await ethers.provider.getBlock("latest")).timestamp;
            rewardStartTimestamp = Math.ceil(t / WEEK) * WEEK + WEEK * 10 + SETTLEMENT_TIME;
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp)
                .returns(parseEther("1"));
            await advanceBlockAtTime(rewardStartTimestamp);

            rate1 = parseEther("1").mul(USER1_LP).div(TOTAL_LP);
            rate2 = parseEther("1").mul(USER2_LP).div(TOTAL_LP);
        });

        it("Should mint rewards on claimRewards()", async function () {
            await advanceBlockAtTime(rewardStartTimestamp + 100);
            expect((await liquidityGauge.callStatic.claimableRewards(addr1)).chessAmount).to.equal(
                rate1.mul(100)
            );
            expect((await liquidityGauge.callStatic.claimableRewards(addr2)).chessAmount).to.equal(
                rate2.mul(100)
            );

            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + 300);
                await liquidityGauge.claimRewards(addr1);
            }).to.callMocks({
                func: chessSchedule.mock.mint.withArgs(addr1, rate1.mul(300)),
            });

            await advanceBlockAtTime(rewardStartTimestamp + 800);
            expect((await liquidityGauge.callStatic.claimableRewards(addr1)).chessAmount).to.equal(
                rate1.mul(500)
            );
            expect((await liquidityGauge.callStatic.claimableRewards(addr2)).chessAmount).to.equal(
                rate2.mul(800)
            );

            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + 1000);
                await liquidityGauge.claimRewards(addr1);
            }).to.callMocks({
                func: chessSchedule.mock.mint.withArgs(addr1, rate1.mul(700)),
            });
        });

        it("Should calculate rewards according to boosted working balance", async function () {
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await setNextBlockTime(rewardStartTimestamp + 100);
            await liquidityGauge.syncWithVotingEscrow(addr1);

            await advanceBlockAtTime(rewardStartTimestamp + 300);
            const rate1AfterSync = parseEther("1")
                .mul(USER1_WORKING_BALANCE)
                .div(TOTAL_LP.sub(USER1_LP).add(USER1_WORKING_BALANCE));
            const reward1 = rate1.mul(100).add(rate1AfterSync.mul(200));
            expect((await liquidityGauge.callStatic.claimableRewards(addr1)).chessAmount).to.equal(
                reward1
            );
        });
    });

    describe("Bonus checkpoint", function () {
        let rewardStartTimestamp: number; // Reward rate becomes non-zero at this timestamp.
        let rate1: BigNumber;
        let rate2: BigNumber;

        beforeEach(async function () {
            const t = (await ethers.provider.getBlock("latest")).timestamp;
            rewardStartTimestamp = t + WEEK;
            await usdc.mint(owner.address, parseUsdc("50000"));
            await usdc.approve(swapBonus.address, parseUsdc("50000"));
            await swapBonus.updateBonus(parseUsdc("50000"), rewardStartTimestamp, 1000);
            await advanceBlockAtTime(rewardStartTimestamp);

            rate1 = parseUsdc("50").mul(USER1_LP).div(TOTAL_LP);
            rate2 = parseUsdc("50").mul(USER2_LP).div(TOTAL_LP);
        });

        it("Should transfer bonus on claimRewards()", async function () {
            await advanceBlockAtTime(rewardStartTimestamp + 100);
            expect((await liquidityGauge.callStatic.claimableRewards(addr1)).bonusAmount).to.equal(
                rate1.mul(100)
            );
            expect((await liquidityGauge.callStatic.claimableRewards(addr2)).bonusAmount).to.equal(
                rate2.mul(100)
            );

            await setNextBlockTime(rewardStartTimestamp + 300);
            await liquidityGauge.claimRewards(addr1);
            expect(await usdc.balanceOf(addr1)).to.equal(rate1.mul(300));

            await advanceBlockAtTime(rewardStartTimestamp + 800);
            expect((await liquidityGauge.callStatic.claimableRewards(addr1)).bonusAmount).to.equal(
                rate1.mul(500)
            );
            expect((await liquidityGauge.callStatic.claimableRewards(addr2)).bonusAmount).to.equal(
                rate2.mul(800)
            );

            await advanceBlockAtTime(rewardStartTimestamp + 2000);
            await liquidityGauge.claimRewards(addr1);
            expect(await usdc.balanceOf(addr1)).to.equal(rate1.mul(1000));
            await liquidityGauge.claimRewards(addr2);
            expect(await usdc.balanceOf(addr2)).to.equal(rate2.mul(1000));
        });

        it("Should calculate rewards according to boosted working balance", async function () {
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await setNextBlockTime(rewardStartTimestamp + 100);
            await liquidityGauge.syncWithVotingEscrow(addr1);

            await advanceBlockAtTime(rewardStartTimestamp + 300);
            const rate1AfterSync = parseUsdc("50")
                .mul(USER1_WORKING_BALANCE)
                .div(TOTAL_LP.sub(USER1_LP).add(USER1_WORKING_BALANCE));
            const reward1 = rate1.mul(100).add(rate1AfterSync.mul(200));
            expect((await liquidityGauge.callStatic.claimableRewards(addr1)).bonusAmount).to.equal(
                reward1
            );
        });

        it("Should accumulate multiple rounds of bonus", async function () {
            await advanceBlockAtTime(rewardStartTimestamp + 2000);
            await swap.call(liquidityGauge, "mint", user1.address, TOTAL_LP);
            await usdc.mint(owner.address, parseUsdc("1000"));
            await usdc.approve(swapBonus.address, parseUsdc("1000"));
            await swapBonus.updateBonus(parseUsdc("1000"), rewardStartTimestamp + 3000, 10000);

            await advanceBlockAtTime(rewardStartTimestamp + 6000);
            const newRate1 = parseUsdc("0.1").mul(USER1_LP.add(TOTAL_LP)).div(TOTAL_LP.mul(2));
            const newRate2 = parseUsdc("0.1").mul(USER2_LP).div(TOTAL_LP.mul(2));
            expect((await liquidityGauge.callStatic.claimableRewards(addr1)).bonusAmount).to.equal(
                rate1.mul(1000).add(newRate1.mul(3000))
            );
            expect((await liquidityGauge.callStatic.claimableRewards(addr2)).bonusAmount).to.equal(
                rate2.mul(1000).add(newRate2.mul(3000))
            );

            await setNextBlockTime(rewardStartTimestamp + 7000);
            await liquidityGauge.claimRewards(addr2);
            expect(await usdc.balanceOf(addr2)).to.equal(rate2.mul(1000).add(newRate2.mul(4000)));
        });
    });

    describe("Distribution checkpoint", function () {
        const distQ1 = parseEther("1");
        const distB1 = parseEther("2");
        const distR1 = parseEther("3");
        const distU1 = parseUsdc("4");

        beforeEach(async function () {
            // Distribution uses balances instead of working balances.
            // Update working balances so that they do not equal to balances.
            await votingEscrow.mock.balanceOf.withArgs(addr1).returns(USER1_VE);
            await votingEscrow.mock.balanceOf.withArgs(addr2).returns(USER2_VE);
            await votingEscrow.mock.totalSupply.returns(TOTAL_VE);
            await liquidityGauge.syncWithVotingEscrow(addr1);
            await liquidityGauge.syncWithVotingEscrow(addr2);
            await swap.call(liquidityGauge, "distribute", distQ1, distB1, distR1, distU1, 1);
        });

        it("Should only be called by stable swap", async function () {
            await expect(liquidityGauge.distribute(0, 0, 0, 0, 1)).to.be.revertedWith(
                "Only stable swap"
            );
        });

        it("Should distribute based on LP distribution", async function () {
            await liquidityGauge.syncWithVotingEscrow(addr1);
            expect(await liquidityGauge.latestVersion()).to.equal(1);
            const dist = await liquidityGauge.distributions(1);
            expect(dist.amountQ).to.equal(distQ1);
            expect(dist.amountB).to.equal(distB1);
            expect(dist.amountR).to.equal(distR1);
            expect(dist.quoteAmount).to.equal(distU1);
            const userDist = await liquidityGauge.userDistributions(addr1);
            expect(userDist.amountQ).to.equal(distQ1.mul(USER1_LP).div(TOTAL_LP));
            expect(userDist.amountB).to.equal(distB1.mul(USER1_LP).div(TOTAL_LP));
            expect(userDist.amountR).to.equal(distR1.mul(USER1_LP).div(TOTAL_LP));
            expect(userDist.quoteAmount).to.equal(distU1.mul(USER1_LP).div(TOTAL_LP));
            expect(await liquidityGauge.userVersions(addr1)).to.equal(1);
        });

        it("Should accumulate distributions over rebalances", async function () {
            await liquidityGauge.syncWithVotingEscrow(addr1);
            const distQ2 = parseEther("10");
            const distB2 = parseEther("20");
            const distR2 = parseEther("30");
            const distU2 = parseUsdc("40");
            await swap.call(liquidityGauge, "distribute", distQ2, distB2, distR2, distU2, 2);
            const distQ3 = parseEther("100");
            const distB3 = parseEther("200");
            const distR3 = parseEther("300");
            const distU3 = parseUsdc("400");
            await swap.call(liquidityGauge, "distribute", distQ3, distB3, distR3, distU3, 3);

            await expect(() =>
                swap.call(liquidityGauge, "mint", user1.address, USER1_LP.mul(100))
            ).to.callMocks(
                {
                    func: fund.mock.doRebalance.withArgs(
                        distQ1.mul(USER1_LP).div(TOTAL_LP),
                        distB1.mul(USER1_LP).div(TOTAL_LP),
                        distR1.mul(USER1_LP).div(TOTAL_LP),
                        1
                    ),
                    rets: [parseEther("4"), parseEther("5"), parseEther("6")],
                },
                {
                    func: fund.mock.doRebalance.withArgs(
                        distQ2.mul(USER1_LP).div(TOTAL_LP).add(parseEther("4")),
                        distB2.mul(USER1_LP).div(TOTAL_LP).add(parseEther("5")),
                        distR2.mul(USER1_LP).div(TOTAL_LP).add(parseEther("6")),
                        2
                    ),
                    rets: [parseEther("40"), parseEther("50"), parseEther("60")],
                }
            );

            expect(await liquidityGauge.latestVersion()).to.equal(3);
            const userDist = await liquidityGauge.userDistributions(addr1);
            expect(userDist.amountQ).to.equal(
                distQ3.mul(USER1_LP).div(TOTAL_LP).add(parseEther("40"))
            );
            expect(userDist.amountB).to.equal(
                distB3.mul(USER1_LP).div(TOTAL_LP).add(parseEther("50"))
            );
            expect(userDist.amountR).to.equal(
                distR3.mul(USER1_LP).div(TOTAL_LP).add(parseEther("60"))
            );
            expect(userDist.quoteAmount).to.equal(
                distU1.add(distU2).add(distU3).mul(USER1_LP).div(TOTAL_LP)
            );
            expect(await liquidityGauge.userVersions(addr1)).to.equal(3);
        });

        it("Should transfer tokens on claimRewards()", async function () {
            await usdc.mint(liquidityGauge.address, parseUsdc("4"));
            const amountQ = distQ1.mul(USER1_LP).div(TOTAL_LP);
            const amountB = distB1.mul(USER1_LP).div(TOTAL_LP);
            const amountR = distR1.mul(USER1_LP).div(TOTAL_LP);
            await expect(() => liquidityGauge.claimRewards(addr1)).to.callMocks(
                {
                    func: fund.mock.trancheTransfer.withArgs(TRANCHE_Q, addr1, amountQ, 1),
                },
                {
                    func: fund.mock.trancheTransfer.withArgs(TRANCHE_B, addr1, amountB, 1),
                },
                {
                    func: fund.mock.trancheTransfer.withArgs(TRANCHE_R, addr1, amountR, 1),
                }
            );
            expect(await usdc.balanceOf(addr1)).to.equal(distU1.mul(USER1_LP).div(TOTAL_LP));
        });
    });
});
