import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";
import { deployMockForName } from "./mock";
import { parseEther } from "@ethersproject/units";

const MIN_WEIGHT = parseEther("0.05");

describe("ChessController upgrade V3 to V4", function () {
    this.timeout(60000); // The deployment fixture is complex and slow

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly fund0: MockContract;
        readonly fund1: MockContract;
        readonly fund2: MockContract;
        readonly controllerBallot: MockContract;
        readonly proxyAdmin: Contract;
        readonly chessControllerV4Impl: Contract;
        readonly chessController: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let fund0: MockContract;
    let fund1: MockContract;
    let fund2: MockContract;
    let controllerBallot: MockContract;
    let proxyAdmin: Contract;
    let chessControllerV4Impl: Contract;
    let chessController: Contract;

    async function upgradeToV4(lastTimestamp: number): Promise<void> {
        const initTx = await chessControllerV4Impl.populateTransaction.initializeV4(lastTimestamp);
        await proxyAdmin.upgradeAndCall(
            chessController.address,
            chessControllerV4Impl.address,
            initTx.data
        );
        chessController = await ethers.getContractAt("ChessControllerV4", chessController.address);
    }

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK + SETTLEMENT_TIME;

        const fund0 = await deployMockForName(owner, "IFund");
        const fund1 = await deployMockForName(owner, "IFund");
        const fund2 = await deployMockForName(owner, "IFund");
        const controllerBallot = await deployMockForName(owner, "IControllerBallot");

        // Deploy the proxy with V2 implememtation
        const ChessControllerV2 = await ethers.getContractFactory("ChessControllerV2");
        const chessControllerV2Impl = await ChessControllerV2.connect(owner).deploy(
            fund0.address,
            fund1.address,
            startWeek,
            MIN_WEIGHT
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const initV2Tx = await chessControllerV2Impl.populateTransaction.initialize([
            parseEther("0.8"),
        ]);
        const chessControllerProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            chessControllerV2Impl.address,
            proxyAdmin.address,
            initV2Tx.data
        );
        const chessController = ChessControllerV2.attach(chessControllerProxy.address);

        // Update weights for the first week
        await advanceBlockAtTime(startWeek);
        await chessController.getFundRelativeWeight(fund1.address, startWeek);

        // Upgrade to V3
        const ChessControllerV3 = await ethers.getContractFactory("ChessControllerV3");
        const chessControllerV3Impl = await ChessControllerV3.connect(owner).deploy(
            fund0.address,
            fund1.address,
            fund2.address,
            startWeek,
            startWeek + WEEK,
            MIN_WEIGHT
        );
        const initV3Tx = await chessControllerV3Impl.populateTransaction.initializeV3([
            parseEther("0.1"),
        ]);
        await proxyAdmin.upgradeAndCall(
            chessController.address,
            chessControllerV3Impl.address,
            initV3Tx.data
        );

        // Update weights for the second week
        await advanceBlockAtTime(startWeek + WEEK);
        await fund0.mock.currentDay.returns(startWeek + WEEK + DAY);
        await fund0.mock.historicalTotalShares.returns(parseEther("400"));
        await fund0.mock.historicalNavs.returns(parseEther("1"), 0, 0);
        await fund1.mock.currentDay.returns(startWeek + WEEK + DAY);
        await fund1.mock.historicalTotalShares.returns(parseEther("100"));
        await fund1.mock.historicalNavs.returns(parseEther("1"), 0, 0);
        await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK);
        await fund0.mock.currentDay.revertsWithReason("Mock on the method is not initialized");
        await fund1.mock.currentDay.revertsWithReason("Mock on the method is not initialized");

        // Deploy the V4 implementation
        const ChessControllerV4 = await ethers.getContractFactory("ChessControllerV4");
        const chessControllerV4Impl = await ChessControllerV4.connect(owner).deploy(
            fund0.address,
            startWeek,
            controllerBallot.address
        );

        return {
            wallets: { user1, owner },
            startWeek,
            fund0,
            fund1,
            fund2,
            controllerBallot,
            proxyAdmin,
            chessControllerV4Impl,
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
        startWeek = fixtureData.startWeek;
        fund0 = fixtureData.fund0;
        fund1 = fixtureData.fund1;
        fund2 = fixtureData.fund2;
        controllerBallot = fixtureData.controllerBallot;
        proxyAdmin = fixtureData.proxyAdmin;
        chessControllerV4Impl = fixtureData.chessControllerV4Impl;
        chessController = fixtureData.chessController;
    });

    describe("initializeV4()", function () {
        it("Should revert if timestamp not aligned to weeks", async function () {
            await expect(upgradeToV4(startWeek + WEEK + DAY)).to.be.reverted;
        });

        it("Should revert if timestamp is too early", async function () {
            await expect(upgradeToV4(startWeek - WEEK * 2)).to.be.reverted;
        });

        it("Should revert if timestamp is not the last updated week", async function () {
            await expect(upgradeToV4(startWeek - WEEK)).to.be.revertedWith(
                "Next week already updated"
            );
            await expect(upgradeToV4(startWeek)).to.be.revertedWith("Next week already updated");
            await expect(upgradeToV4(startWeek + WEEK * 2)).to.be.revertedWith(
                "Last week not updated"
            );
        });

        it("Should revert if already initialized", async function () {
            await upgradeToV4(startWeek + WEEK);
            await expect(upgradeToV4(startWeek + WEEK)).to.be.revertedWith("Already initialized");
        });
    });

    describe("getFundRelativeWeight()", function () {
        beforeEach(async function () {
            await upgradeToV4(startWeek + WEEK);
        });

        it("Should return weights in previous weeks", async function () {
            expect(await getWeight(fund0, startWeek - WEEK)).to.equal(parseEther("1"));
            expect(await getWeight(fund1, startWeek - WEEK)).to.equal(0);
            expect(await getWeight(fund2, startWeek - WEEK)).to.equal(0);
            expect(await getWeight(fund0, startWeek)).to.equal(parseEther("0.8"));
            expect(await getWeight(fund1, startWeek)).to.equal(parseEther("0.2"));
            expect(await getWeight(fund2, startWeek)).to.equal(0);
            expect(await getWeight(fund0, startWeek + WEEK)).to.equal(parseEther("0.72"));
            expect(await getWeight(fund1, startWeek + WEEK)).to.equal(parseEther("0.18"));
            expect(await getWeight(fund2, startWeek + WEEK)).to.equal(parseEther("0.1"));
        });

        it("Should not skip a week", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 3);
            await expect(getWeight(fund0, startWeek + WEEK * 3)).to.be.revertedWith(
                "Previous week is empty"
            );
        });

        it("Should calculate weights", async function () {
            // Ballot result: 50%, 30%, 20%
            // TVL distribution: 60%, 30%, 10%
            // Final weights: 55%, 30%, 15%
            await controllerBallot.mock.count
                .withArgs(startWeek + WEEK * 2)
                .returns(
                    [parseEther("0.5"), parseEther("0.3"), parseEther("0.2")],
                    [fund0.address, fund1.address, fund2.address]
                );
            await fund0.mock.currentDay.returns(startWeek + WEEK * 2 + DAY);
            await fund0.mock.historicalTotalShares.returns(parseEther("600"));
            await fund1.mock.currentDay.returns(startWeek + WEEK * 2 + DAY);
            await fund1.mock.historicalTotalShares.returns(parseEther("300"));
            await fund2.mock.currentDay.returns(startWeek + WEEK * 2 + DAY);
            await fund2.mock.historicalTotalShares.returns(parseEther("100"));
            await fund2.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await advanceBlockAtTime(startWeek + WEEK * 2);
            expect(await getWeight(fund0, startWeek + WEEK * 2)).to.equal(parseEther("0.55"));
            expect(await getWeight(fund1, startWeek + WEEK * 2)).to.equal(parseEther("0.3"));
            expect(await getWeight(fund2, startWeek + WEEK * 2)).to.equal(parseEther("0.15"));
        });
    });
});
