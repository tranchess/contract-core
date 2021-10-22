import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";
import { deployMockForName } from "./mock";
import { parseEther } from "@ethersproject/units";

describe("ChessControllerV2", function () {
    const WINDOW_SIZE = 2;

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
    let fund1: MockContract;
    let fund2: MockContract;
    let chessController: Contract;

    const minWeight = parseEther("0.15");

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
            minWeight
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
        fund1 = fixtureData.fund1;
        fund2 = fixtureData.fund2;
        chessController = fixtureData.chessController;

        // The tvl ratio: 9%, 21%, 25%, 33%, 45%, 57%, 65%
        await fund1.mock.historicalTotalShares.withArgs(startWeek).returns(parseEther("3"));
        await fund1.mock.historicalTotalShares.withArgs(startWeek + WEEK).returns(parseEther("7"));
        await fund1.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("5"));
        await fund1.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 3)
            .returns(parseEther("11"));
        await fund1.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 4)
            .returns(parseEther("9"));
        await fund1.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 5)
            .returns(parseEther("3"));
        await fund1.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 6)
            .returns(parseEther("5"));

        await fund1.mock.historicalNavs
            .withArgs(startWeek)
            .returns(parseEther("3"), parseEther("0"), parseEther("0"));
        await fund1.mock.historicalNavs
            .withArgs(startWeek + WEEK)
            .returns(parseEther("3"), parseEther("0"), parseEther("0"));
        await fund1.mock.historicalNavs
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("5"), parseEther("0"), parseEther("0"));
        await fund1.mock.historicalNavs
            .withArgs(startWeek + WEEK * 3)
            .returns(parseEther("3"), parseEther("0"), parseEther("0"));
        await fund1.mock.historicalNavs
            .withArgs(startWeek + WEEK * 4)
            .returns(parseEther("5"), parseEther("0"), parseEther("0"));
        await fund1.mock.historicalNavs
            .withArgs(startWeek + WEEK * 5)
            .returns(parseEther("19"), parseEther("0"), parseEther("0"));
        await fund1.mock.historicalNavs
            .withArgs(startWeek + WEEK * 6)
            .returns(parseEther("13"), parseEther("0"), parseEther("0"));

        await fund2.mock.historicalTotalShares.withArgs(startWeek).returns(parseEther("7"));
        await fund2.mock.historicalTotalShares.withArgs(startWeek + WEEK).returns(parseEther("1"));
        await fund2.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("5"));
        await fund2.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 3)
            .returns(parseEther("67"));
        await fund2.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 4)
            .returns(parseEther("11"));
        await fund2.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 5)
            .returns(parseEther("43"));
        await fund2.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 6)
            .returns(parseEther("5"));

        await fund2.mock.historicalNavs
            .withArgs(startWeek)
            .returns(parseEther("13"), parseEther("0"), parseEther("0"));
        await fund2.mock.historicalNavs
            .withArgs(startWeek + WEEK)
            .returns(parseEther("79"), parseEther("0"), parseEther("0"));
        await fund2.mock.historicalNavs
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("15"), parseEther("0"), parseEther("0"));
        await fund2.mock.historicalNavs
            .withArgs(startWeek + WEEK * 3)
            .returns(parseEther("1"), parseEther("0"), parseEther("0"));
        await fund2.mock.historicalNavs
            .withArgs(startWeek + WEEK * 4)
            .returns(parseEther("5"), parseEther("0"), parseEther("0"));
        await fund2.mock.historicalNavs
            .withArgs(startWeek + WEEK * 5)
            .returns(parseEther("1"), parseEther("0"), parseEther("0"));
        await fund2.mock.historicalNavs
            .withArgs(startWeek + WEEK * 6)
            .returns(parseEther("7"), parseEther("0"), parseEther("0"));
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

            advanceBlockAtTime(startWeek + WEEK);
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
        const week4Ratio0 = parseEther("0.5")
            .mul(WINDOW_SIZE - 1)
            .add(parseEther("0.45"))
            .div(WINDOW_SIZE);
        const week5Ratio0 = week4Ratio0
            .mul(WINDOW_SIZE - 1)
            .add(parseEther("0.57"))
            .div(WINDOW_SIZE);
        const week6Ratio0 = week5Ratio0
            .mul(WINDOW_SIZE - 1)
            .add(parseEther("0.65"))
            .div(WINDOW_SIZE);

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

        it("Should revert if previous weight is empty", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 6);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await expect(
                chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 6)
            ).to.be.revertedWith("Previous week is empty");
        });

        it("Should return previous unrecorded weight", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 6);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 5);
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 6);
            expect(await chessController.weights(startWeek + WEEK * 5, fund1.address)).to.equal(
                week5Ratio0
            );
            expect(await chessController.weights(startWeek + WEEK * 6, fund1.address)).to.equal(
                week6Ratio0
            );
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
            await fund1.mock.historicalNavs.returns(
                parseEther("0"),
                parseEther("0"),
                parseEther("0")
            );
            await fund2.mock.historicalNavs.returns(
                parseEther("1"),
                parseEther("0"),
                parseEther("0")
            );
            await fund1.mock.historicalTotalShares.returns(parseEther("0"));
            await fund2.mock.historicalTotalShares.returns(parseEther("1"));
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
            ).to.equal(minWeight);
        });

        it("Should return max weight", async function () {
            await fund1.mock.historicalNavs.returns(
                parseEther("1"),
                parseEther("0"),
                parseEther("0")
            );
            await fund2.mock.historicalNavs.returns(
                parseEther("0"),
                parseEther("0"),
                parseEther("0")
            );
            await fund1.mock.historicalTotalShares.returns(parseEther("1"));
            await fund2.mock.historicalTotalShares.returns(parseEther("0"));
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
            ).to.equal(parseEther("1").sub(minWeight));
        });
    });

    describe("updateFundWeight()", function () {
        const week4Ratio0 = parseEther("0.5")
            .mul(WINDOW_SIZE - 1)
            .add(parseEther("0.45"))
            .div(WINDOW_SIZE);

        beforeEach(async function () {
            await advanceBlockAtTime(startWeek + WEEK * 4);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
            await fund2.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
        });

        it("Should return relative weight for funds", async function () {
            expect(await chessController.weights(startWeek + WEEK * 4, fund1.address)).to.equal(
                parseEther("0")
            );

            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4);

            expect(await chessController.weights(startWeek + WEEK * 4, fund1.address)).to.equal(
                week4Ratio0
            );
            expect(await chessController.weights(startWeek + WEEK * 4, fund2.address)).to.equal(
                parseEther("1").sub(week4Ratio0)
            );
        });

        it("Should return old relative weight for funds", async function () {
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4);
            await fund1.mock.historicalTotalShares.returns(parseEther("2"));
            await fund2.mock.historicalTotalShares.returns(parseEther("4"));
            await fund1.mock.historicalNavs.returns(
                parseEther("3"),
                parseEther("0"),
                parseEther("0")
            );
            await fund2.mock.historicalNavs.returns(
                parseEther("1"),
                parseEther("0"),
                parseEther("0")
            );
            await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 4);

            expect(await chessController.weights(startWeek + WEEK * 4, fund1.address)).to.equal(
                week4Ratio0
            );
            expect(await chessController.weights(startWeek + WEEK * 4, fund2.address)).to.equal(
                parseEther("1").sub(week4Ratio0)
            );
        });
    });
});
