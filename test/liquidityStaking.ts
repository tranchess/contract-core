import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parsePrecise = (value: string) => parseUnits(value, 27);
import { WEEK, FixtureWalletMap, advanceBlockAtTime, setAutomine } from "./utils";

describe("Staking", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startTimestamp: number;
        readonly endTimestamp: number;
        readonly rewardToken: Contract;
        readonly stakedToken: Contract;
        readonly staking: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let user3: Wallet;
    let user4: Wallet;
    let addr1: string;
    let addr2: string;
    let addr3: string;
    let addr4: string;
    let startTimestamp: number;
    let endTimestamp: number;
    let rewardToken: Contract;
    let stakedToken: Contract;
    let staking: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, user4, owner] = provider.getWallets();

        const startEpoch = (await ethers.provider.getBlock("latest")).timestamp;
        const startTimestamp = startEpoch + WEEK;
        const endTimestamp = startTimestamp + WEEK * 10;

        const MockToken = await ethers.getContractFactory("MockToken");
        const rewardToken = await MockToken.connect(owner).deploy("Reward Token", "CHESS", 18);
        const stakedToken = await MockToken.connect(owner).deploy("LP Token", "LP", 18);

        const Staking = await ethers.getContractFactory("LiquidityStaking");
        const staking = await Staking.connect(owner).deploy(
            rewardToken.address,
            stakedToken.address,
            startTimestamp,
            endTimestamp
        );

        await rewardToken.mint(owner.address, parseEther("1").mul(10 * WEEK));
        await rewardToken.approve(staking.address, parseEther("1").mul(10 * WEEK));

        await stakedToken.mint(user1.address, parseEther("100"));
        await stakedToken.mint(user2.address, parseEther("100"));
        await stakedToken.mint(user3.address, parseEther("100"));
        await stakedToken.mint(user4.address, parseEther("100"));
        await stakedToken.connect(user1).approve(staking.address, parseEther("100"));
        await stakedToken.connect(user2).approve(staking.address, parseEther("100"));
        await stakedToken.connect(user3).approve(staking.address, parseEther("100"));
        await stakedToken.connect(user4).approve(staking.address, parseEther("100"));

        return {
            wallets: { user1, user2, user3, user4 },
            startTimestamp: startTimestamp,
            endTimestamp: endTimestamp,
            rewardToken: rewardToken,
            stakedToken: stakedToken,
            staking: staking,
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        startTimestamp = fixtureData.startTimestamp;
        endTimestamp = fixtureData.endTimestamp;
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        user3 = fixtureData.wallets.user3;
        user4 = fixtureData.wallets.user4;
        addr1 = user1.address;
        addr2 = user2.address;
        addr3 = user3.address;
        addr4 = user4.address;
        rewardToken = fixtureData.rewardToken;
        stakedToken = fixtureData.stakedToken;
        staking = fixtureData.staking;
    });

    describe("initialize()", function () {
        it("Should initialize", async function () {
            expect(await rewardToken.balanceOf(staking.address)).to.equal(0);
            expect(await staking.rate()).to.equal(0);
            expect(await staking.lastTimestamp()).to.equal(startTimestamp);
            expect(await staking.globalIntegral()).to.equal(0);
            expect(await staking.totalStakes()).to.equal(0);

            await staking.initialize(parseEther("1"));

            expect(await rewardToken.balanceOf(staking.address)).to.equal(
                parseEther("1").mul(10 * WEEK)
            );
            expect(await staking.rate()).to.equal(parseEther("1"));
            expect(await staking.lastTimestamp()).to.equal(startTimestamp);
            expect(await staking.globalIntegral()).to.equal(0);
            expect(await staking.totalStakes()).to.equal(0);
        });
    });

    describe("deposit()", function () {
        beforeEach(async function () {
            await staking.initialize(parseEther("1"));
        });

        it("Should deposit before start timestamp", async function () {
            expect(await stakedToken.balanceOf(staking.address)).to.equal(0);
            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(0);
            expect(await staking.lastTimestamp()).to.equal(startTimestamp);
            expect(await staking.globalIntegral()).to.equal(0);
            expect(await staking.totalStakes()).to.equal(0);
            expect(await staking.stakes(addr1)).to.equal(0);

            await staking.connect(user1).deposit(parseEther("10"));

            expect(await stakedToken.balanceOf(staking.address)).to.equal(parseEther("10"));
            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(0);
            expect(await staking.lastTimestamp()).to.equal(startTimestamp);
            expect(await staking.globalIntegral()).to.equal(0);
            expect(await staking.totalStakes()).to.equal(parseEther("10"));
            expect(await staking.stakes(addr1)).to.equal(parseEther("10"));
        });

        it("Should deposit before start timestamp and start accumulating rewards after start timestamp", async function () {
            const USER1_AMOUNT = parseEther("30");
            const USER2_AMOUNT = parseEther("10");
            const TOTAL_AMOUNT = USER1_AMOUNT.add(USER2_AMOUNT);

            await staking.connect(user1).deposit(USER1_AMOUNT);
            await staking.connect(user2).deposit(USER2_AMOUNT);
            advanceBlockAtTime(startTimestamp + 10);
            await staking.userCheckpoint(addr1);
            let currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;

            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(
                parseEther((currentTimestamp - startTimestamp).toString())
                    .mul(USER1_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.connect(user2).callStatic["claimRewards"]()).to.equal(
                parseEther((currentTimestamp - startTimestamp).toString())
                    .mul(USER2_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.lastTimestamp()).to.equal(currentTimestamp);
            expect(await staking.globalIntegral()).to.equal(
                parsePrecise("1")
                    .mul(parseEther((currentTimestamp - startTimestamp).toString()))
                    .div(TOTAL_AMOUNT)
            );

            await staking.userCheckpoint(addr2);
            currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
            expect(await staking.connect(user2).callStatic["claimRewards"]()).to.equal(
                parseEther((currentTimestamp - startTimestamp).toString())
                    .mul(USER2_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.lastTimestamp()).to.equal(currentTimestamp);
            expect(await staking.globalIntegral()).to.equal(
                parsePrecise("1")
                    .mul(parseEther((currentTimestamp - startTimestamp).toString()))
                    .div(TOTAL_AMOUNT)
            );
        });

        it("Should deposit and accumulate rewards after start timestamp", async function () {
            const USER1_AMOUNT = parseEther("30");
            const USER2_AMOUNT = parseEther("10");
            const TOTAL_AMOUNT = USER1_AMOUNT.add(USER2_AMOUNT);

            await setAutomine(false);
            await staking.connect(user1).deposit(USER1_AMOUNT);
            await staking.connect(user2).deposit(USER2_AMOUNT);
            advanceBlockAtTime(startTimestamp);
            await setAutomine(true);

            advanceBlockAtTime(startTimestamp + WEEK);
            await staking.userCheckpoint(addr1);
            const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;

            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(
                parseEther((currentTimestamp - startTimestamp).toString())
                    .mul(USER1_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.connect(user2).callStatic["claimRewards"]()).to.equal(
                parseEther((currentTimestamp - startTimestamp).toString())
                    .mul(USER2_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.lastTimestamp()).to.equal(currentTimestamp);
            expect(await staking.globalIntegral()).to.equal(
                parsePrecise("1")
                    .mul(parseEther((currentTimestamp - startTimestamp).toString()))
                    .div(TOTAL_AMOUNT)
            );
        });

        it("Should deposit but receive no more rewards after end timestamp", async function () {
            const USER1_AMOUNT = parseEther("30");
            const USER2_AMOUNT = parseEther("10");
            const TOTAL_AMOUNT = USER1_AMOUNT.add(USER2_AMOUNT);
            await staking.connect(user1).deposit(USER1_AMOUNT);
            await staking.connect(user2).deposit(USER2_AMOUNT);

            advanceBlockAtTime(startTimestamp + 11 * WEEK);
            await staking.userCheckpoint(addr1);
            await staking.userCheckpoint(addr2);

            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(
                parseEther((10 * WEEK).toString())
                    .mul(USER1_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.connect(user2).callStatic["claimRewards"]()).to.equal(
                parseEther((10 * WEEK).toString())
                    .mul(USER2_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.lastTimestamp()).to.equal(endTimestamp);
            expect(await staking.globalIntegral()).to.equal(
                parsePrecise("1")
                    .mul(parseEther((endTimestamp - startTimestamp).toString()))
                    .div(TOTAL_AMOUNT)
            );
        });
    });

    describe("withdraw()", function () {
        beforeEach(async function () {
            await staking.initialize(parseEther("1"));
            await staking.connect(user1).deposit(parseEther("30"));
            await staking.connect(user2).deposit(parseEther("10"));
        });

        it("Should withdraw before start timestamp", async function () {
            await staking.connect(user1).withdraw(parseEther("10"));

            expect(await stakedToken.balanceOf(staking.address)).to.equal(parseEther("30"));
            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(0);
            expect(await staking.lastTimestamp()).to.equal(startTimestamp);
            expect(await staking.globalIntegral()).to.equal(0);
            expect(await staking.totalStakes()).to.equal(parseEther("30"));
            expect(await staking.stakes(addr1)).to.equal(parseEther("20"));
        });

        it("Should withdraw deposits deposited before start timestamp", async function () {
            const USER1_AMOUNT = parseEther("30");
            const USER2_AMOUNT = parseEther("10");
            const TOTAL_AMOUNT = USER1_AMOUNT.add(USER2_AMOUNT);

            advanceBlockAtTime(startTimestamp + 10);
            await staking.connect(user1).withdraw(parseEther("10"));
            const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;

            expect(await stakedToken.balanceOf(staking.address)).to.equal(parseEther("30"));
            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(
                parseEther((currentTimestamp - startTimestamp).toString())
                    .mul(USER1_AMOUNT)
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.lastTimestamp()).to.equal(currentTimestamp);
            expect(await staking.globalIntegral()).to.equal(
                parsePrecise("1")
                    .mul(parseEther((currentTimestamp - startTimestamp).toString()))
                    .div(TOTAL_AMOUNT)
            );
            expect(await staking.totalStakes()).to.equal(parseEther("30"));
            expect(await staking.stakes(addr1)).to.equal(parseEther("20"));
        });
    });

    describe("claimRewards()", function () {
        beforeEach(async function () {
            await staking.initialize(parseEther("1"));
        });

        it("Should claim rewards", async function () {
            const USER1_AMOUNT = parseEther("10");
            const USER2_AMOUNT = parseEther("20");
            const USER3_AMOUNT = parseEther("30");
            const USER4_AMOUNT = parseEther("40");
            const TOTAL_AMOUNT = USER1_AMOUNT.add(USER2_AMOUNT).add(USER3_AMOUNT).add(USER4_AMOUNT);

            await setAutomine(false);
            await staking.connect(user1).deposit(USER1_AMOUNT);
            await staking.connect(user2).deposit(USER2_AMOUNT);
            await staking.connect(user3).deposit(USER3_AMOUNT);
            await staking.connect(user4).deposit(USER4_AMOUNT);
            await advanceBlockAtTime(startTimestamp);
            await setAutomine(true);

            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(0);

            await setAutomine(false);
            await staking.connect(user1).deposit(parseEther("10"));
            await staking.connect(user2).withdraw(parseEther("10"));
            await staking.connect(user3).deposit(parseEther("10"));
            await staking.connect(user4).withdraw(parseEther("10"));
            await advanceBlockAtTime(startTimestamp + 1 * WEEK);
            await setAutomine(true);

            let user1Reward = parseEther(WEEK.toString()).mul(USER1_AMOUNT).div(TOTAL_AMOUNT);
            let user2Reward = parseEther(WEEK.toString()).mul(USER2_AMOUNT).div(TOTAL_AMOUNT);
            let user3Reward = parseEther(WEEK.toString()).mul(USER3_AMOUNT).div(TOTAL_AMOUNT);
            let user4Reward = parseEther(WEEK.toString()).mul(USER4_AMOUNT).div(TOTAL_AMOUNT);

            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(user1Reward);
            expect(await staking.connect(user2).callStatic["claimRewards"]()).to.equal(user2Reward);
            expect(await staking.connect(user3).callStatic["claimRewards"]()).to.equal(user3Reward);
            expect(await staking.connect(user4).callStatic["claimRewards"]()).to.equal(user4Reward);

            await setAutomine(false);
            await staking.connect(user1).withdraw(parseEther("20"));
            await staking.connect(user2).deposit(parseEther("20"));
            await staking.connect(user3).withdraw(parseEther("20"));
            await staking.connect(user4).deposit(parseEther("20"));
            await advanceBlockAtTime(startTimestamp + 2 * WEEK);
            await setAutomine(true);

            user1Reward = user1Reward.add(
                parseEther(WEEK.toString())
                    .mul(USER1_AMOUNT.add(parseEther("10")))
                    .div(TOTAL_AMOUNT)
            );
            user2Reward = user2Reward.add(
                parseEther(WEEK.toString())
                    .mul(USER2_AMOUNT.sub(parseEther("10")))
                    .div(TOTAL_AMOUNT)
            );
            user3Reward = user3Reward.add(
                parseEther(WEEK.toString())
                    .mul(USER3_AMOUNT.add(parseEther("10")))
                    .div(TOTAL_AMOUNT)
            );
            user4Reward = user4Reward.add(
                parseEther(WEEK.toString())
                    .mul(USER4_AMOUNT.sub(parseEther("10")))
                    .div(TOTAL_AMOUNT)
            );

            expect(await staking.connect(user1).callStatic["claimRewards"]()).to.equal(user1Reward);
            expect(await staking.connect(user2).callStatic["claimRewards"]()).to.equal(user2Reward);
            expect(await staking.connect(user3).callStatic["claimRewards"]()).to.equal(user3Reward);
            expect(await staking.connect(user4).callStatic["claimRewards"]()).to.equal(user4Reward);

            await setAutomine(false);
            await staking.connect(user1).claimRewards();
            await staking.connect(user2).claimRewards();
            await staking.connect(user3).claimRewards();
            await staking.connect(user4).claimRewards();
            await advanceBlockAtTime(startTimestamp + 3 * WEEK);
            await setAutomine(true);

            user1Reward = user1Reward.add(0);
            user2Reward = user2Reward.add(
                parseEther(WEEK.toString())
                    .mul(USER2_AMOUNT.add(parseEther("10")))
                    .div(TOTAL_AMOUNT)
            );
            user3Reward = user3Reward.add(
                parseEther(WEEK.toString())
                    .mul(USER3_AMOUNT.sub(parseEther("10")))
                    .div(TOTAL_AMOUNT)
            );
            user4Reward = user4Reward.add(
                parseEther(WEEK.toString())
                    .mul(USER4_AMOUNT.add(parseEther("10")))
                    .div(TOTAL_AMOUNT)
            );

            expect(await rewardToken.balanceOf(addr1)).to.equal(user1Reward);
            expect(await rewardToken.balanceOf(addr2)).to.equal(user2Reward);
            expect(await rewardToken.balanceOf(addr3)).to.equal(user3Reward);
            expect(await rewardToken.balanceOf(addr4)).to.equal(user4Reward);
        });
    });

    describe("exit()", function () {
        beforeEach(async function () {
            await staking.initialize(parseEther("1"));
            await staking.connect(user1).deposit(parseEther("10"));
            await staking.connect(user2).deposit(parseEther("20"));
        });

        it("Should exit", async function () {
            await advanceBlockAtTime(startTimestamp + WEEK);

            await staking.connect(user1).exit();
            const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;

            expect(await staking.totalStakes()).to.equal(parseEther("20"));
            expect(await stakedToken.balanceOf(addr1)).to.equal(parseEther("100"));
            expect(await rewardToken.balanceOf(addr1)).to.equal(
                parseEther((currentTimestamp - startTimestamp).toString())
                    .mul(parseEther("10"))
                    .div(parseEther("30"))
            );
        });
    });
});
