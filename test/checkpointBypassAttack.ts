import { expect } from "chai";
import { BigNumberish, Contract, Wallet } from "ethers";
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
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setAutomine,
} from "./utils";

const UPPER_REBALANCE_THRESHOLD = parseEther("2");
const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");

describe("checkpointBypassAttack", function () {
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
        readonly aprOracleProxy: Contract;
        readonly staking: Contract;
        readonly fund: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startDay: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let twapOracle: MockContract;
    let btc: Contract;
    let primaryMarket: MockContract;
    let aprOracleProxy: Contract;
    let staking: Contract;
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

        const Fund = await ethers.getContractFactory("FundV4");
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
        await fund.initialize(parseEther("500"), parseEther("1"), parseEther("1"), 0);

        const chessSchedule = await deployMockForName(owner, "IChessSchedule");
        await chessSchedule.mock.getWeeklySupply.returns(0);
        await chessSchedule.mock.getRate.returns(0);
        await chessSchedule.mock.mint.returns();

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
            0
        );

        const BscAprOracleProxy = await ethers.getContractFactory("BscAprOracleProxy");
        const aprOracleProxy = await BscAprOracleProxy.connect(owner).deploy(
            aprOracle.address,
            fund.address,
            staking.address
        );

        await fund.updateAprOracle(aprOracleProxy.address);

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
            aprOracleProxy,
            staking: staking.connect(user1),
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
        startDay = fixtureData.startDay;
        twapOracle = fixtureData.twapOracle;
        btc = fixtureData.btc;
        aprOracleProxy = fixtureData.aprOracleProxy;
        primaryMarket = fixtureData.primaryMarket;
        staking = fixtureData.staking;
        fund = fixtureData.fund;
    });

    describe("Settlement of a non-empty fund", function () {
        const DAILY_PROTOCOL_FEE_BPS = 1; // 0.01% per day

        beforeEach(async function () {
            await fund
                .connect(owner)
                .updateDailyProtocolFeeRate(parseEther("0.0001").mul(DAILY_PROTOCOL_FEE_BPS));
            // Create 10 QUEEN with 10 BTC on the first day.
            await pmCreate(user1, parseBtc("10"), parseEther("10"));
            await twapOracle.mock.getTwap.withArgs(startDay).returns(parseEther("1000"));
            await advanceOneDayAndSettle();
            await primaryMarket.call(
                fund,
                "primaryMarketBurn",
                TRANCHE_Q,
                user1.address,
                parseEther("3"),
                0
            );
            await primaryMarket.call(
                fund,
                "primaryMarketMint",
                TRANCHE_B,
                aprOracleProxy.address,
                parseEther("500"),
                0
            );
            await primaryMarket.call(
                fund,
                "primaryMarketMint",
                TRANCHE_R,
                aprOracleProxy.address,
                parseEther("500"),
                0
            );
            await primaryMarket.call(
                fund,
                "primaryMarketMint",
                TRANCHE_B,
                user1.address,
                parseEther("1000"),
                0
            );
            await primaryMarket.call(
                fund,
                "primaryMarketMint",
                TRANCHE_R,
                user1.address,
                parseEther("1000"),
                0
            );
            await fund.trancheApprove(TRANCHE_Q, staking.address, parseEther("0.5"), 0);
            await fund.trancheApprove(TRANCHE_B, staking.address, parseEther("0.5"), 0);
            await fund.trancheApprove(TRANCHE_R, staking.address, parseEther("0.5"), 0);
            await staking.deposit(TRANCHE_Q, parseEther("0.5"), user1.address, 0);
            await staking.deposit(TRANCHE_B, parseEther("0.5"), user1.address, 0);
            await staking.deposit(TRANCHE_R, parseEther("0.5"), user1.address, 0);
            await advanceBlockAtTime((await fund.currentDay()).toNumber());
        });

        it("Should allow settlement if no upper rebalance triggered", async function () {
            const price = parseEther("1500");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await setAutomine(false);
            await staking.claimRewards(user2.address);
            await setAutomine(true);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(0);
        });

        it("Should block settlement if upper rebalance triggered", async function () {
            const price = parseEther("1510");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarket.mock.split
                .withArgs(aprOracleProxy.address, parseEther("0.3376158741695355"), 1)
                .returns(0);
            await setAutomine(false);
            await staking.claimRewards(user2.address);
            await setAutomine(true);
            await expect(fund.settle()).to.be.revertedWith("Rebalance check failed");
            expect(await fund.getRebalanceSize()).to.equal(0);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(1);
        });

        it("Should allow settlement if no lower rebalance triggered", async function () {
            const price = parseEther("755");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await setAutomine(false);
            await staking.claimRewards(user2.address);
            await setAutomine(true);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(0);
        });

        it("Should block settlement if lower rebalance triggered", async function () {
            const price = parseEther("750");
            await twapOracle.mock.getTwap.withArgs(startDay + DAY).returns(price);
            await primaryMarket.mock.split
                .withArgs(aprOracleProxy.address, parseEther("0.3362685736853845"), 1)
                .returns(0);
            // Supply enough BISHOP and ROOK to shareStaking to enable the attack
            await fund.trancheTransfer(TRANCHE_B, staking.address, parseEther("0.8"), 0);
            await fund.trancheTransfer(TRANCHE_R, staking.address, parseEther("0.8"), 0);
            await setAutomine(false);
            await staking.claimRewards(user2.address);
            await setAutomine(true);
            await expect(fund.settle()).to.be.revertedWith("Rebalance check failed");
            expect(await fund.getRebalanceSize()).to.equal(0);
            await fund.settle();
            expect(await fund.getRebalanceSize()).to.equal(1);
        });
    });
});
