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
        const chessController = await ChessControllerV2.connect(owner).deploy(
            [fund1.address, fund2.address],
            startWeek,
            parseEther("0.2"),
            parseEther("0.8")
        );

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
    });

    describe("updateGuardedLaunchRatio()", function () {
        it("Should return guarded launch ratio", async function () {
            expect(
                await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK)
            ).to.equal(parseEther("0.2"));
            expect(
                await chessController.getFundRelativeWeight(fund2.address, startWeek + WEEK)
            ).to.equal(parseEther("0.8"));
        });

        it("Should revert if not owner", async function () {
            await expect(
                chessController.updateGuardedLaunchRatio(parseEther("0.3"), parseEther("0.7"))
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should revert on invalid guarded launch ratio", async function () {
            await expect(
                chessController
                    .connect(owner)
                    .updateGuardedLaunchRatio(parseEther("0.3"), parseEther("0.6"))
            ).to.be.revertedWith("Invalid ratio");
        });

        it("Should return guarded launch ratio", async function () {
            await chessController
                .connect(owner)
                .updateGuardedLaunchRatio(parseEther("0.3"), parseEther("0.7"));
            expect(
                await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK)
            ).to.equal(parseEther("0.3"));
            expect(
                await chessController.getFundRelativeWeight(fund2.address, startWeek + WEEK)
            ).to.equal(parseEther("0.7"));
        });
    });

    describe("getFundRelativeWeight()", function () {
        before(async function () {
            await advanceBlockAtTime(startWeek + WEEK * 4);
        });

        beforeEach(async function () {
            await fund1.mock.currentDay.returns(startWeek + WEEK * 5 - DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 5 - DAY);
            await fund1.mock.historicalUnderlying.returns(parseEther("6"));
            await fund2.mock.historicalUnderlying.returns(parseEther("2"));
            await twapOracle1.mock.getTwap.returns(parseEther("7"));
            await twapOracle2.mock.getTwap.returns(parseEther("29"));
        });

        it("Should return previous recorded weight", async function () {
            expect(
                await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 5)
            ).to.equal(parseEther("0"));
        });

        it("Should return relative weight for funds", async function () {
            expect(
                await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("0.42"));
            expect(
                await chessController.getFundRelativeWeight(fund2.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("0.58"));
        });
    });

    describe("updateFundRelativeWeight()", function () {
        beforeEach(async function () {
            await advanceBlockAtTime(startWeek + WEEK * 4);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 5 - DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 5 - DAY);
            await fund1.mock.historicalUnderlying.returns(parseEther("6"));
            await fund2.mock.historicalUnderlying.returns(parseEther("2"));
            await twapOracle1.mock.getTwap.returns(parseEther("7"));
            await twapOracle2.mock.getTwap.returns(parseEther("29"));
        });

        it("Should return relative weight for funds", async function () {
            expect(
                await chessController.relativeWeights(fund1.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("0"));

            await chessController.updateFundRelativeWeight();

            expect(
                await chessController.relativeWeights(fund1.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("0.42"));
            expect(
                await chessController.relativeWeights(fund2.address, startWeek + WEEK * 4)
            ).to.equal(parseEther("0.58"));
        });
    });
});
