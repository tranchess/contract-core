import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";
import { deployMockForName } from "./mock";
import { parseEther } from "@ethersproject/units";

describe("ChessControllerV4", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly fund0: MockContract;
        readonly fund1: MockContract;
        readonly fund2: MockContract;
        readonly controllerBallot: MockContract;
        readonly chessController: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let startWeek: number;
    let fund0: MockContract;
    let fund1: MockContract;
    let fund2: MockContract;
    let controllerBallot: MockContract;
    let chessController: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;
        await advanceBlockAtTime(startWeek);

        const fund0 = await deployMockForName(owner, "IFund");
        const fund1 = await deployMockForName(owner, "IFund");
        const fund2 = await deployMockForName(owner, "IFund");
        const controllerBallot = await deployMockForName(owner, "IControllerBallot");

        const ChessControllerV4 = await ethers.getContractFactory("ChessControllerV4");
        const chessControllerV4Impl = await ChessControllerV4.connect(owner).deploy(
            fund0.address,
            startWeek,
            controllerBallot.address
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const initTx = await chessControllerV4Impl.populateTransaction.initializeV4(
            startWeek - WEEK
        );
        const chessControllerProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            chessControllerV4Impl.address,
            proxyAdmin.address,
            initTx.data
        );
        const chessController = ChessControllerV4.attach(chessControllerProxy.address);

        return {
            wallets: { user1, owner },
            startWeek,
            fund0,
            fund1,
            fund2,
            controllerBallot,
            chessController: chessController.connect(user1),
        };
    }

    async function getWeight(fund: Contract | Wallet, timestamp: number): Promise<BigNumber> {
        return await chessController.callStatic.getFundRelativeWeight(fund.address, timestamp);
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        startWeek = fixtureData.startWeek;
        fund0 = fixtureData.fund0;
        fund1 = fixtureData.fund1;
        fund2 = fixtureData.fund2;
        controllerBallot = fixtureData.controllerBallot;
        chessController = fixtureData.chessController;
    });

    describe("getFundRelativeWeight()", function () {
        const weight0 = parseEther("0.55");
        const weight1 = parseEther("0.3");
        const weight2 = parseEther("0.15");

        beforeEach(async function () {
            // Ballot result: 50%, 30%, 20%
            // TVL distribution: 60%, 30%, 10%
            // Final weights: 55%, 30%, 15%
            await controllerBallot.mock.count
                .withArgs(startWeek)
                .returns(
                    [parseEther("0.5"), parseEther("0.3"), parseEther("0.2")],
                    [fund0.address, fund1.address, fund2.address]
                );
            await fund0.mock.currentDay.returns(startWeek + DAY);
            await fund0.mock.historicalTotalShares.withArgs(startWeek).returns(parseEther("600"));
            await fund0.mock.historicalNavs.withArgs(startWeek).returns(parseEther("1"), 0, 0);
            await fund1.mock.currentDay.returns(startWeek + DAY);
            await fund1.mock.historicalTotalShares.withArgs(startWeek).returns(parseEther("300"));
            await fund1.mock.historicalNavs.withArgs(startWeek).returns(parseEther("1"), 0, 0);
            await fund2.mock.currentDay.returns(startWeek + DAY);
            await fund2.mock.historicalTotalShares.withArgs(startWeek).returns(parseEther("100"));
            await fund2.mock.historicalNavs.withArgs(startWeek).returns(parseEther("1"), 0, 0);
        });

        it("Should return weights in previous weeks", async function () {
            expect(await getWeight(fund0, startWeek - 1)).to.equal(parseEther("1"));
            expect(await getWeight(fund1, startWeek - 1)).to.equal(0);
            expect(await getWeight(fund2, startWeek - 1)).to.equal(0);
            expect(await getWeight(user1, startWeek - 1)).to.equal(0);
        });

        it("Should reject future timestamp", async function () {
            await expect(getWeight(fund0, startWeek + WEEK)).to.be.revertedWith("Too soon");
        });

        it("Should not skip a week", async function () {
            await advanceBlockAtTime(startWeek + WEEK);
            await expect(getWeight(fund0, startWeek + WEEK)).to.be.revertedWith(
                "Previous week is empty"
            );
        });

        it("Should calculate weights", async function () {
            expect(await getWeight(fund0, startWeek)).to.equal(weight0);
            expect(await getWeight(fund1, startWeek)).to.equal(weight1);
            expect(await getWeight(fund2, startWeek)).to.equal(weight2);
        });

        it("Should return zero for unknown address", async function () {
            expect(await getWeight(user1, startWeek)).to.equal(0);
            expect(await getWeight(chessController, startWeek)).to.equal(0);
        });

        it("Should update weights", async function () {
            await chessController.getFundRelativeWeight(fund0.address, startWeek);
            expect(await chessController.weights(startWeek, fund0.address)).to.equal(weight0);
            expect(await chessController.weights(startWeek, fund1.address)).to.equal(weight1);
            expect(await chessController.weights(startWeek, fund2.address)).to.equal(weight2);
        });

        it("Should return existing weights without recalculation", async function () {
            await chessController.getFundRelativeWeight(fund0.address, startWeek);
            await controllerBallot.mock.count
                .withArgs(startWeek)
                .returns([parseEther("1"), 0, 0], [fund0.address, fund1.address, fund2.address]);
            expect(await getWeight(fund0, startWeek)).to.equal(weight0);
            expect(await getWeight(fund1, startWeek)).to.equal(weight1);
            expect(await getWeight(fund2, startWeek)).to.equal(weight2);
            // Irrelavent query should not trigger recalculation
            expect(await getWeight(chessController, startWeek)).to.equal(0);
            expect(await getWeight(fund0, startWeek)).to.equal(weight0);
            expect(await getWeight(fund1, startWeek)).to.equal(weight1);
            expect(await getWeight(fund2, startWeek)).to.equal(weight2);
        });

        it("Should update last timestamp", async function () {
            expect(await chessController.lastTimestamp()).to.equal(startWeek - WEEK);
            await chessController.getFundRelativeWeight(fund0.address, startWeek);
            expect(await chessController.lastTimestamp()).to.equal(startWeek);
        });

        it("Should emit event", async function () {
            let snapshot = await ethers.provider.send("evm_snapshot", []);
            await expect(chessController.getFundRelativeWeight(fund0.address, startWeek))
                .to.emit(chessController, "WeightUpdated")
                .withArgs(fund0.address, startWeek, weight0);
            await ethers.provider.send("evm_revert", [snapshot]);
            snapshot = await ethers.provider.send("evm_snapshot", []);
            await expect(chessController.getFundRelativeWeight(fund0.address, startWeek))
                .to.emit(chessController, "WeightUpdated")
                .withArgs(fund1.address, startWeek, weight1);
            await ethers.provider.send("evm_revert", [snapshot]);
            await expect(chessController.getFundRelativeWeight(fund0.address, startWeek))
                .to.emit(chessController, "WeightUpdated")
                .withArgs(fund2.address, startWeek, weight2);
        });

        it("Should check total weights", async function () {
            await controllerBallot.mock.count
                .withArgs(startWeek)
                .returns(
                    [parseEther("0.4"), parseEther("0.4"), parseEther("0.4")],
                    [fund0.address, fund1.address, fund2.address]
                );
            await expect(
                chessController.getFundRelativeWeight(fund0.address, startWeek)
            ).to.be.revertedWith("Total weight exceeds 100%");
        });
    });
});
