import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";
import { deployMockForName } from "./mock";
import { parseEther } from "@ethersproject/units";

describe("ChessControllerV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly fund1: MockContract;
        readonly fund2: MockContract;
        readonly twapOracle1: MockContract;
        readonly twapOracle2: MockContract;
        readonly chessController: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let owner: Wallet;
    let fund1: MockContract;
    let fund2: MockContract;
    let twapOracle1: MockContract;
    let twapOracle2: MockContract;
    let chessController: Contract;

    const minRatio = parseEther("0.15");

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek =
            Math.floor((startTimestamp - SETTLEMENT_TIME) / WEEK) * WEEK + SETTLEMENT_TIME;

        const twapOracle1 = await deployMockForName(owner, "ITwapOracle");
        const twapOracle2 = await deployMockForName(owner, "ITwapOracle");
        const fund1 = await deployMockForName(owner, "IFund");
        const fund2 = await deployMockForName(owner, "IFund");

        await fund1.mock.twapOracle.returns(twapOracle1.address);
        await fund2.mock.twapOracle.returns(twapOracle2.address);

        const ChessControllerV2 = await ethers.getContractFactory("ChessControllerV2");
        const chessControllerImpl = await ChessControllerV2.connect(owner).deploy(
            fund1.address,
            fund2.address,
            startWeek,
            minRatio
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const initTx = await chessControllerImpl.populateTransaction.initialize([
            parseEther("0.2"),
            parseEther("0.3"),
            parseEther("0.4"),
            parseEther("0.5"),
        ]);
        const chessControllerProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            chessControllerImpl.address,
            proxyAdmin.address,
            initTx.data
        );
        const chessController = ChessControllerV2.attach(chessControllerProxy.address);

        return {
            wallets: { user1, owner },
            startWeek,
            fund1,
            fund2,
            twapOracle1,
            twapOracle2,
            chessController: chessController.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        startWeek = fixtureData.startWeek;
        owner = fixtureData.wallets.owner;
        fund1 = fixtureData.fund1;
        fund2 = fixtureData.fund2;
        twapOracle1 = fixtureData.twapOracle1;
        twapOracle2 = fixtureData.twapOracle2;
        chessController = fixtureData.chessController;

        // The tvl ratio: 9%, 21%, 25%, 33%, 45%, 57%
        await fund1.mock.historicalUnderlying.withArgs(startWeek).returns(parseEther("3"));
        await fund1.mock.historicalUnderlying.withArgs(startWeek + WEEK).returns(parseEther("7"));
        await fund1.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("5"));
        await fund1.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 3)
            .returns(parseEther("11"));
        await fund1.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 4)
            .returns(parseEther("9"));
        await fund1.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 5)
            .returns(parseEther("3"));

        await twapOracle1.mock.getTwap.withArgs(startWeek).returns(parseEther("3"));
        await twapOracle1.mock.getTwap.withArgs(startWeek + WEEK).returns(parseEther("3"));
        await twapOracle1.mock.getTwap.withArgs(startWeek + WEEK * 2).returns(parseEther("5"));
        await twapOracle1.mock.getTwap.withArgs(startWeek + WEEK * 3).returns(parseEther("3"));
        await twapOracle1.mock.getTwap.withArgs(startWeek + WEEK * 4).returns(parseEther("5"));
        await twapOracle1.mock.getTwap.withArgs(startWeek + WEEK * 5).returns(parseEther("19"));

        await fund2.mock.historicalUnderlying.withArgs(startWeek).returns(parseEther("7"));
        await fund2.mock.historicalUnderlying.withArgs(startWeek + WEEK).returns(parseEther("1"));
        await fund2.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("5"));
        await fund2.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 3)
            .returns(parseEther("67"));
        await fund2.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 4)
            .returns(parseEther("11"));
        await fund2.mock.historicalUnderlying
            .withArgs(startWeek + WEEK * 5)
            .returns(parseEther("43"));

        await twapOracle2.mock.getTwap.withArgs(startWeek).returns(parseEther("13"));
        await twapOracle2.mock.getTwap.withArgs(startWeek + WEEK).returns(parseEther("79"));
        await twapOracle2.mock.getTwap.withArgs(startWeek + WEEK * 2).returns(parseEther("15"));
        await twapOracle2.mock.getTwap.withArgs(startWeek + WEEK * 3).returns(parseEther("1"));
        await twapOracle2.mock.getTwap.withArgs(startWeek + WEEK * 4).returns(parseEther("5"));
        await twapOracle2.mock.getTwap.withArgs(startWeek + WEEK * 5).returns(parseEther("1"));
    });

    describe("updateGuardedLaunchRatio()", function () {
        it("Should return guarded launch ratio", async function () {
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund1.address,
                    startWeek - 1
                )
            ).to.equal(parseEther("1"));
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund2.address,
                    startWeek - 1
                )
            ).to.equal(parseEther("0"));

            await fund1.mock.currentDay.returns(startWeek + DAY);
            await fund2.mock.currentDay.returns(startWeek + DAY);
            expect(
                await chessController.callStatic["getFundRelativeWeight"](fund1.address, startWeek)
            ).to.equal(parseEther("0.2"));
            expect(
                await chessController.callStatic["getFundRelativeWeight"](fund2.address, startWeek)
            ).to.equal(parseEther("0.8"));

            await fund1.mock.currentDay.returns(startWeek + WEEK + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK + DAY);
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund1.address,
                    startWeek + WEEK
                )
            ).to.equal(parseEther("0.3"));
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund2.address,
                    startWeek + WEEK
                )
            ).to.equal(parseEther("0.7"));
        });
    });

    describe("getFundRelativeWeight()", function () {
        const week4Ratio0 = parseEther("0.5").mul(75).add(parseEther("0.45").mul(25)).div(100);
        const week5Ratio0 = week4Ratio0.mul(75).add(parseEther("0.57").mul(25)).div(100);

        beforeEach(async function () {
            await fund1.mock.currentDay.returns(startWeek + DAY);
            await fund2.mock.currentDay.returns(startWeek + DAY);
            await chessController.getFundRelativeWeight(fund1.address, startWeek);

            await advanceBlockAtTime(startWeek + WEEK);
            await fund1.mock.currentDay.returns(startWeek + WEEK + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK + DAY);
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK);

            await advanceBlockAtTime(startWeek + WEEK * 2);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 2 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 2 + DAY);
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 2);

            await advanceBlockAtTime(startWeek + WEEK * 3);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 3 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 3 + DAY);
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 3);

            await advanceBlockAtTime(startWeek + WEEK * 4);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4);
        });

        it("Should return previous recorded weight", async function () {
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund1.address,
                    startWeek + WEEK * 4
                )
            ).to.equal(week4Ratio0);
        });

        it("Should return relative weight for funds", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 5);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 5 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 5 + DAY);
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund1.address,
                    startWeek + WEEK * 5
                )
            ).to.equal(week5Ratio0);
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund2.address,
                    startWeek + WEEK * 5
                )
            ).to.equal(parseEther("1").sub(week5Ratio0));
        });

        it("Should return min weight", async function () {
            await twapOracle1.mock.getTwap.returns(parseEther("0"));
            await twapOracle2.mock.getTwap.returns(parseEther("1"));
            await fund1.mock.historicalUnderlying.returns(parseEther("0"));
            await fund2.mock.historicalUnderlying.returns(parseEther("1"));
            await fund1.mock.currentDay.returns(startWeek + WEEK * 5);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 5);
            for (let i = 5; i < 10; i++) {
                await advanceBlockAtTime(startWeek + WEEK * i);
                await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * i);
            }
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund1.address,
                    startWeek + WEEK * 9
                )
            ).to.equal(minRatio);
        });

        it("Should return max weight", async function () {
            await twapOracle1.mock.getTwap.returns(parseEther("1"));
            await twapOracle2.mock.getTwap.returns(parseEther("0"));
            await fund1.mock.historicalUnderlying.returns(parseEther("1"));
            await fund2.mock.historicalUnderlying.returns(parseEther("0"));
            await fund1.mock.currentDay.returns(startWeek + WEEK * 5);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 5);
            for (let i = 5; i < 10; i++) {
                await advanceBlockAtTime(startWeek + WEEK * i);
                await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * i);
            }
            expect(
                await chessController.callStatic["getFundRelativeWeight"](
                    fund1.address,
                    startWeek + WEEK * 9
                )
            ).to.equal(parseEther("1").sub(minRatio));
        });
    });

    describe("updateFundRelativeWeight()", function () {
        const week4Ratio0 = parseEther("0.5").mul(75).add(parseEther("0.45").mul(25)).div(100);

        beforeEach(async function () {
            await advanceBlockAtTime(startWeek + WEEK * 4);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
        });

        it("Should return relative weight for funds", async function () {
            expect(
                await chessController.relativeWeights(fund1.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("0"));

            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4);

            expect(
                await chessController.relativeWeights(fund1.address, startWeek + WEEK * 4)
            ).to.equal(week4Ratio0);
            expect(
                await chessController.relativeWeights(fund2.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("1").sub(week4Ratio0));
        });

        it("Should return old relative weight for funds", async function () {
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4);
            await fund1.mock.historicalUnderlying.returns(parseEther("2"));
            await fund2.mock.historicalUnderlying.returns(parseEther("4"));
            await twapOracle1.mock.getTwap.returns(parseEther("3"));
            await twapOracle2.mock.getTwap.returns(parseEther("1"));
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4);

            expect(
                await chessController.relativeWeights(fund1.address, startWeek + WEEK * 4)
            ).to.equal(week4Ratio0);
            expect(
                await chessController.relativeWeights(fund2.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("1").sub(week4Ratio0));
        });
    });
});