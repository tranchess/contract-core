import { expect } from "chai";
import { BigNumber, constants, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseUsdc = (value: string) => parseUnits(value, 6);
import { deployMockForName } from "./mock";
import {
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
        readonly checkpointTimestamp: number;
        readonly fund: MockContract;
        readonly swap: MockContract;
        readonly chessSchedule: MockContract;
        readonly votingEscrow: MockContract;
        readonly usdc: Contract;
        readonly tokens: Contract[];
        readonly liquidityGauge: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let checkpointTimestamp: number;
    let user1: Wallet;
    let user2: Wallet;
    let addr1: string;
    let addr2: string;
    let fund: MockContract;
    let swap: MockContract;
    let chessSchedule: MockContract;
    let votingEscrow: MockContract;
    let usdc: Contract;
    let tokens: Contract[];
    let liquidityGauge: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const checkpointTimestamp = (await ethers.provider.getBlock("latest")).timestamp;

        const startEpoch = (await ethers.provider.getBlock("latest")).timestamp;
        await advanceBlockAtTime(Math.floor(startEpoch / WEEK) * WEEK + WEEK);

        const fund = await deployMockForName(owner, "IFundV3");

        const swap = await deployMockForName(owner, "BishopStableSwap");

        const chessSchedule = await deployMockForName(owner, "IChessSchedule");
        await chessSchedule.mock.getRate.returns(0);

        const chessController = await deployMockForName(owner, "IChessController");
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(TOTAL_VE);

        const MockToken = await ethers.getContractFactory("MockToken");
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);
        const tokens = [
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
        ];
        await fund.mock.tokenQ.returns(tokens[0].address);
        await fund.mock.tokenB.returns(tokens[1].address);
        await fund.mock.tokenR.returns(tokens[2].address);
        await swap.mock.quoteAddress.returns(usdc.address);

        const SwapReward = await ethers.getContractFactory("SwapReward");
        const swapReward = await SwapReward.connect(owner).deploy();
        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const liquidityGauge = await LiquidityGauge.connect(owner).deploy(
            "Test LP",
            "TLP",
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address,
            swapReward.address
        );
        await liquidityGauge.transferOwnership(swap.address);
        await swapReward.initialize(liquidityGauge.address, usdc.address);

        // Deposit initial shares
        await swap.call(liquidityGauge, "mint", user1.address, USER1_LP);
        await swap.call(liquidityGauge, "mint", user2.address, USER2_LP);

        return {
            wallets: { user1, user2, owner },
            checkpointTimestamp,
            fund,
            swap,
            chessSchedule,
            votingEscrow,
            usdc,
            tokens,
            liquidityGauge,
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
        addr1 = user1.address;
        addr2 = user2.address;
        fund = fixtureData.fund;
        swap = fixtureData.swap;
        chessSchedule = fixtureData.chessSchedule;
        votingEscrow = fixtureData.votingEscrow;
        usdc = fixtureData.usdc;
        tokens = fixtureData.tokens;
        liquidityGauge = fixtureData.liquidityGauge;
    });

    describe("mint()", function () {
        it("Should revert if not owner", async function () {
            await expect(liquidityGauge.mint(addr1, 10000)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
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
        it("Should revert if not owner", async function () {
            await expect(liquidityGauge.burnFrom(addr1, 10000)).to.be.revertedWith(
                "Ownable: caller is not the owner"
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

        it("Should update working balance on deposit()", async function () {
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

        it("Should update working balance on withdraw()", async function () {
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

        it("Should update working balance on claimTokenAndAssetAndReward()", async function () {
            await chessSchedule.mock.mint.returns();
            await liquidityGauge.claimTokenAndAssetAndReward(addr1);
            expect(await liquidityGauge.workingBalanceOf(addr1)).to.equal(USER1_WORKING_BALANCE);
            expect(await liquidityGauge.workingSupply()).to.equal(
                USER1_WORKING_BALANCE.add(USER2_LP)
            );
        });
    });

    describe("Snapshot", function () {
        beforeEach(async function () {
            await tokens[0].mint(liquidityGauge.address, parseEther("12"));
            await tokens[1].mint(liquidityGauge.address, parseEther("23"));
            await tokens[2].mint(liquidityGauge.address, parseEther("34"));
            await usdc.mint(liquidityGauge.address, parseUsdc("45"));
            await swap.call(
                liquidityGauge,
                "distribute",
                parseEther("12"),
                parseEther("23"),
                parseEther("34"),
                parseUsdc("45"),
                1
            );
        });

        it("Should allocate based on LP distribution", async function () {
            await fund.mock.doRebalance.withArgs(0, 0, 0, 0).returns(0, 0, 0);
            await liquidityGauge.userCheckpoint(addr1);
            expect((await liquidityGauge.distributions(0))[0]).to.equal(parseEther("12"));
            expect((await liquidityGauge.distributions(0))[1]).to.equal(parseEther("23"));
            expect((await liquidityGauge.distributions(0))[2]).to.equal(parseEther("34"));
            expect((await liquidityGauge.distributions(0))[3]).to.equal(parseUsdc("45"));
            expect(await liquidityGauge.claimableAssets(addr1, 0)).to.equal(
                parseEther("12").mul(USER1_LP).div(TOTAL_LP)
            );
            expect(await liquidityGauge.claimableAssets(addr1, 1)).to.equal(
                parseEther("23").mul(USER1_LP).div(TOTAL_LP)
            );
            expect(await liquidityGauge.claimableAssets(addr1, 2)).to.equal(
                parseEther("34").mul(USER1_LP).div(TOTAL_LP)
            );
            expect(await liquidityGauge.claimableAssets(addr1, 3)).to.equal(
                parseUsdc("45").mul(USER1_LP).div(TOTAL_LP)
            );
            expect(await liquidityGauge.distributionVersions(addr1)).to.equal(1);
        });

        it("Should distribute for new rebalance", async function () {
            await fund.mock.doRebalance.returns(parseEther("1"), parseEther("2"), parseEther("3"));
            await fund.mock.doRebalance.withArgs(0, 0, 0, 0).returns(0, 0, 0);
            await tokens[0].mint(liquidityGauge.address, parseEther("10"));
            await tokens[1].mint(liquidityGauge.address, parseEther("10"));
            await tokens[2].mint(liquidityGauge.address, parseEther("10"));
            await usdc.mint(liquidityGauge.address, parseUsdc("10"));
            await swap.call(
                liquidityGauge,
                "distribute",
                parseEther("10"),
                parseEther("10"),
                parseEther("10"),
                parseUsdc("10"),
                2
            );

            await liquidityGauge.userCheckpoint(addr1);

            expect((await liquidityGauge.distributions(1))[0]).to.equal(parseEther("10"));
            expect((await liquidityGauge.distributions(1))[1]).to.equal(parseEther("10"));
            expect((await liquidityGauge.distributions(1))[2]).to.equal(parseEther("10"));
            expect((await liquidityGauge.distributions(1))[3]).to.equal(parseUsdc("10"));
            expect(await liquidityGauge.claimableAssets(addr1, 0)).to.equal(
                parseEther("1").add(parseEther("10").mul(USER1_LP).div(TOTAL_LP))
            );
            expect(await liquidityGauge.claimableAssets(addr1, 1)).to.equal(
                parseEther("2").add(parseEther("10").mul(USER1_LP).div(TOTAL_LP))
            );
            expect(await liquidityGauge.claimableAssets(addr1, 2)).to.equal(
                parseEther("3").add(parseEther("10").mul(USER1_LP).div(TOTAL_LP))
            );
            expect(await liquidityGauge.claimableAssets(addr1, 3)).to.equal(
                parseUsdc("55").mul(USER1_LP).div(TOTAL_LP)
            );
            expect(await liquidityGauge.distributionVersions(addr1)).to.equal(2);
        });
    });

    describe("Reward", function () {
        let rewardStartTimestamp: number; // Reward rate becomes non-zero at this timestamp.
        let rate1: BigNumber;
        let rate2: BigNumber;

        beforeEach(async function () {
            rewardStartTimestamp =
                Math.floor(checkpointTimestamp / WEEK) * WEEK + WEEK * 10 + SETTLEMENT_TIME;
            await chessSchedule.mock.getRate
                .withArgs(rewardStartTimestamp)
                .returns(parseEther("1"));
            await advanceBlockAtTime(rewardStartTimestamp);

            rate1 = parseEther("1").mul(USER1_LP).div(TOTAL_LP);
            rate2 = parseEther("1").mul(USER2_LP).div(TOTAL_LP);
        });

        it("Should mint rewards on claimTokenAndAssetAndReward()", async function () {
            await advanceBlockAtTime(rewardStartTimestamp + 100);

            expect(
                (await liquidityGauge.callStatic["claimableTokenAndAssetAndReward"](addr1))[0]
            ).to.equal(rate1.mul(100));
            expect(
                (await liquidityGauge.callStatic["claimableTokenAndAssetAndReward"](addr2))[0]
            ).to.equal(rate2.mul(100));

            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + 300);
                await liquidityGauge.claimTokenAndAssetAndReward(addr1);
            }).to.callMocks({
                func: chessSchedule.mock.mint.withArgs(addr1, rate1.mul(300)),
            });

            await advanceBlockAtTime(rewardStartTimestamp + 800);
            expect(
                (await liquidityGauge.callStatic["claimableTokenAndAssetAndReward"](addr1))[0]
            ).to.equal(rate1.mul(500));
            expect(
                (await liquidityGauge.callStatic["claimableTokenAndAssetAndReward"](addr2))[0]
            ).to.equal(rate2.mul(800));

            await expect(async () => {
                await setNextBlockTime(rewardStartTimestamp + 1000);
                await liquidityGauge.claimTokenAndAssetAndReward(addr1);
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

            const reward1 = rate1
                .mul(100)
                .add(
                    parseEther("1")
                        .mul(200)
                        .mul(USER1_WORKING_BALANCE)
                        .div(TOTAL_LP.sub(USER1_LP).add(USER1_WORKING_BALANCE))
                );
            const reward2 = rate2
                .mul(100)
                .add(
                    parseEther("1")
                        .mul(200)
                        .mul(USER2_LP)
                        .div(TOTAL_LP.sub(USER1_LP).add(USER1_WORKING_BALANCE))
                );

            expect(
                (await liquidityGauge.callStatic["claimableTokenAndAssetAndReward"](addr1))[0]
            ).to.equal(reward1);
            expect(
                (await liquidityGauge.callStatic["claimableTokenAndAssetAndReward"](addr2))[0]
            ).to.equal(reward2);
        });
    });
});
