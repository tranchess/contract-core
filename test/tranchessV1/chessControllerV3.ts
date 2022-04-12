import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";
import { deployMockForName } from "../mock";
import { parseEther } from "@ethersproject/units";

const MIN_WEIGHT = parseEther("0.05");

describe("ChessControllerV3", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly fund0: MockContract;
        readonly fund1: MockContract;
        readonly fund2: MockContract;
        readonly proxyAdmin: Contract;
        readonly chessControllerV3Impl: Contract;
        readonly chessController: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let startWeek: number;
    let fund0: MockContract;
    let fund1: MockContract;
    let fund2: MockContract;
    let proxyAdmin: Contract;
    let chessControllerV3Impl: Contract;
    let chessController: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek =
            Math.ceil((startTimestamp - SETTLEMENT_TIME) / WEEK) * WEEK + SETTLEMENT_TIME;

        const fund0 = await deployMockForName(owner, "IFund");
        const fund1 = await deployMockForName(owner, "IFund");
        const fund2 = await deployMockForName(owner, "IFund");

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
        const initTx = await chessControllerV2Impl.populateTransaction.initialize([
            parseEther("0.8"),
            parseEther("0.6"),
        ]);
        const chessControllerProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            chessControllerV2Impl.address,
            proxyAdmin.address,
            initTx.data
        );
        const chessController = ChessControllerV2.attach(chessControllerProxy.address);

        await advanceBlockAtTime(startWeek + WEEK * 2 + DAY);
        await fund0.mock.currentDay.returns(startWeek + WEEK * 2 + DAY);
        await fund0.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("400")); // 80% total TVL
        await fund0.mock.historicalNavs
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("1"), parseEther("1"), parseEther("1"));
        await fund1.mock.currentDay.returns(startWeek + WEEK * 2 + DAY);
        await fund1.mock.historicalTotalShares
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("100")); // 20% total TVL
        await fund1.mock.historicalNavs
            .withArgs(startWeek + WEEK * 2)
            .returns(parseEther("1"), parseEther("1"), parseEther("1"));
        await chessController.getFundRelativeWeight(fund1.address, startWeek);
        await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK);
        await chessController.getFundRelativeWeight(fund1.address, startWeek + WEEK * 2);
        await fund0.mock.currentDay.revertsWithReason("Mock on the method is not initialized");
        await fund1.mock.currentDay.revertsWithReason("Mock on the method is not initialized");

        const ChessControllerV3 = await ethers.getContractFactory("ChessControllerV3");
        const chessControllerV3Impl = await ChessControllerV3.connect(owner).deploy(
            fund0.address,
            fund1.address,
            fund2.address,
            startWeek,
            startWeek + WEEK * 4,
            MIN_WEIGHT
        );

        return {
            wallets: { user1, owner },
            startWeek,
            fund0,
            fund1,
            fund2,
            proxyAdmin,
            chessControllerV3Impl,
            chessController: ChessControllerV3.attach(chessController.address).connect(user1),
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
        proxyAdmin = fixtureData.proxyAdmin;
        chessControllerV3Impl = fixtureData.chessControllerV3Impl;
        chessController = fixtureData.chessController;
    });

    describe("initializeV3()", function () {
        it("Should initialize before guarded launch V3", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 4);
            const initTx = await chessControllerV3Impl.populateTransaction.initializeV3([
                parseEther("0.1"),
                parseEther("0.2"),
            ]);
            await expect(
                proxyAdmin.upgradeAndCall(
                    chessController.address,
                    chessControllerV3Impl.address,
                    initTx.data
                )
            ).to.be.revertedWith("Too late to initialize");
        });

        it("Should revert if already initialized", async function () {
            const initTx = await chessControllerV3Impl.populateTransaction.initializeV3([
                parseEther("0.1"),
                parseEther("0.2"),
            ]);
            await proxyAdmin.upgradeAndCall(
                chessController.address,
                chessControllerV3Impl.address,
                initTx.data
            );
            await expect(
                chessController.initializeV3([parseEther("0.1"), parseEther("0.2")])
            ).to.be.revertedWith("Already initialized");
        });

        it("Should reject empty array", async function () {
            const initTx = await chessControllerV3Impl.populateTransaction.initializeV3([]);
            await expect(
                proxyAdmin.upgradeAndCall(
                    chessController.address,
                    chessControllerV3Impl.address,
                    initTx.data
                )
            ).to.be.reverted;
        });

        it("Should check min weight", async function () {
            const initTx1 = await chessControllerV3Impl.populateTransaction.initializeV3([
                MIN_WEIGHT.div(2),
                parseEther("0.2"),
            ]);
            const initTx2 = await chessControllerV3Impl.populateTransaction.initializeV3([
                parseEther("1").sub(MIN_WEIGHT),
                parseEther("0.2"),
            ]);
            await expect(
                proxyAdmin.upgradeAndCall(
                    chessController.address,
                    chessControllerV3Impl.address,
                    initTx1.data
                )
            ).to.be.revertedWith("Invalid weight");
            await expect(
                proxyAdmin.upgradeAndCall(
                    chessController.address,
                    chessControllerV3Impl.address,
                    initTx2.data
                )
            ).to.be.revertedWith("Invalid weight");
        });
    });

    describe("getFundRelativeWeight()", function () {
        beforeEach(async function () {
            const initTx = await chessControllerV3Impl.populateTransaction.initializeV3([
                parseEther("0.1"),
                parseEther("0.2"),
            ]);
            await proxyAdmin.upgradeAndCall(
                chessController.address,
                chessControllerV3Impl.address,
                initTx.data
            );
        });

        it("Should return weights in previous weeks", async function () {
            expect(await getWeight(fund0, startWeek - 1)).to.equal(parseEther("1"));
            expect(await getWeight(fund1, startWeek - 1)).to.equal(0);
            expect(await getWeight(fund2, startWeek - 1)).to.equal(0);

            expect(await getWeight(fund0, startWeek + 1)).to.equal(parseEther("0.8"));
            expect(await getWeight(fund1, startWeek + 1)).to.equal(parseEther("0.2"));
            expect(await getWeight(fund2, startWeek + 1)).to.equal(0);

            expect(await getWeight(fund0, startWeek + WEEK)).to.equal(parseEther("0.6"));
            expect(await getWeight(fund1, startWeek + WEEK)).to.equal(parseEther("0.4"));
            expect(await getWeight(fund2, startWeek + WEEK)).to.equal(0);

            // fund0 previous weight: 0.6, previous tvl: 0.8
            // fund0 current weight: (0.6 + 0.8) / 2 = 0.7
            expect(await getWeight(fund0, startWeek + WEEK * 2)).to.equal(parseEther("0.7"));
            // fund0 current weight: (0.4 + 0.2) / 2 = 0.3
            expect(await getWeight(fund1, startWeek + WEEK * 2)).to.equal(parseEther("0.3"));
            expect(await getWeight(fund2, startWeek + WEEK * 2)).to.equal(0);
        });

        it("Should return initialized weights for the new fund", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 10 + DAY);
            expect(await getWeight(fund2, startWeek + WEEK * 3)).to.equal(0);
            expect(await getWeight(fund2, startWeek + WEEK * 4)).to.equal(parseEther("0.1"));
            expect(await getWeight(fund2, startWeek + WEEK * 5)).to.equal(parseEther("0.2"));
            await expect(
                chessController.getFundRelativeWeight(fund2.address, startWeek + WEEK * 6)
            ).to.be.revertedWith("Previous week is empty");
        });

        it("Should reject future timestamp", async function () {
            await expect(getWeight(fund0, startWeek + WEEK * 3)).to.be.revertedWith("Too soon");
        });

        it("Should split weights to two funds before guarded launch V3", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 3 + DAY);
            await expect(() =>
                chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 3)
            ).to.callMocks(
                {
                    func: fund0.mock.currentDay,
                    rets: [startWeek + WEEK * 3 + DAY],
                },
                {
                    func: fund0.mock.historicalNavs.withArgs(startWeek + WEEK * 3),
                    rets: [parseEther("1.25"), parseEther("1"), parseEther("1.5")],
                },
                {
                    func: fund0.mock.historicalTotalShares.withArgs(startWeek + WEEK * 3),
                    rets: [parseEther("800")], // 50% of total TVL
                },
                {
                    func: fund1.mock.currentDay,
                    rets: [startWeek + WEEK * 3 + DAY],
                },
                {
                    func: fund1.mock.historicalNavs.withArgs(startWeek + WEEK * 3),
                    rets: [parseEther("0.8"), parseEther("1"), parseEther("0.9")],
                },
                {
                    func: fund1.mock.historicalTotalShares.withArgs(startWeek + WEEK * 3),
                    rets: [parseEther("1250")], // 50% of total TVL
                }
            );
            // previous weight: 0.7, previous tvl: 0.5
            expect(await getWeight(fund0, startWeek + WEEK * 3)).to.equal(parseEther("0.6"));
            expect(await getWeight(fund1, startWeek + WEEK * 3)).to.equal(parseEther("0.4"));
        });

        it("Should split remaining weights in the first guarded launch week", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 4 + DAY);
            await fund0.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 4 + DAY);
            await fund0.mock.historicalTotalShares.returns(parseEther("300")); // 30% total TVL
            await fund0.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await fund1.mock.historicalTotalShares.returns(parseEther("700")); // 70% total TVL
            await fund1.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            // fund0 previous weight: 0.7, previous tvl: 0.3
            // fund0 current weight: (0.7 + 0.3) / 2 = 0.5
            expect(await getWeight(fund0, startWeek + WEEK * 3)).to.equal(parseEther("0.5"));
            // fund1 current weight: (0.3 + 0.7) / 2 = 0.5
            expect(await getWeight(fund1, startWeek + WEEK * 3)).to.equal(parseEther("0.5"));
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 3);

            // fund0 previous weight: 0.5, previous tvl: 0.3
            // fund0 current weight: (0.5 + 0.3) * (1 - 0.1) / 2 = 0.36
            expect(await getWeight(fund0, startWeek + WEEK * 4)).to.equal(parseEther("0.36"));
            // fund1 current weight: (0.5 + 0.7) * (1 - 0.1) / 2 = 0.54
            expect(await getWeight(fund1, startWeek + WEEK * 4)).to.equal(parseEther("0.54"));
            expect(await getWeight(fund2, startWeek + WEEK * 4)).to.equal(parseEther("0.1"));
        });

        it("Should split remaining weights in the second guarded launch week", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 5 + DAY);
            await fund0.mock.currentDay.returns(startWeek + WEEK * 5 + DAY);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 5 + DAY);
            await fund0.mock.historicalTotalShares.returns(parseEther("300")); // 30% total TVL
            await fund0.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await fund1.mock.historicalTotalShares.returns(parseEther("700")); // 70% total TVL
            await fund1.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 3);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 4);
            // same as the previous case
            expect(await getWeight(fund0, startWeek + WEEK * 4)).to.equal(parseEther("0.36"));
            expect(await getWeight(fund1, startWeek + WEEK * 4)).to.equal(parseEther("0.54"));
            expect(await getWeight(fund2, startWeek + WEEK * 4)).to.equal(parseEther("0.1"));

            // fund0 previous weight: 0.36, previous tvl: 0.3
            // fund0 current weight: (0.36 / (1 - 0.1) + 0.3) * (1 - 0.2) / 2 = 0.28
            expect(await getWeight(fund0, startWeek + WEEK * 5)).to.equal(parseEther("0.28"));
            // fund1 current weight: (0.54 / (1 - 0.1) + 0.7) * (1 - 0.2) / 2 = 0.52
            expect(await getWeight(fund1, startWeek + WEEK * 5)).to.equal(parseEther("0.52"));
            expect(await getWeight(fund2, startWeek + WEEK * 5)).to.equal(parseEther("0.2"));
        });

        it("Should split remaining weights after guarded launch V3", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 6 + DAY);
            await fund0.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await fund0.mock.historicalTotalShares.returns(parseEther("300")); // 30% total TVL
            await fund0.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await fund1.mock.historicalTotalShares.returns(parseEther("700")); // 70% total TVL
            await fund1.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 3);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 4);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 5);
            // same as the previous case
            expect(await getWeight(fund0, startWeek + WEEK * 5)).to.equal(parseEther("0.28"));
            expect(await getWeight(fund1, startWeek + WEEK * 5)).to.equal(parseEther("0.52"));
            expect(await getWeight(fund2, startWeek + WEEK * 5)).to.equal(parseEther("0.2"));

            // fund0 previous weight: 0.28, previous tvl: 0.3
            // fund0 current weight: (0.28 / (1 - 0.2) + 0.3) * (1 - 0.2) / 2 = 0.26
            expect(await getWeight(fund0, startWeek + WEEK * 6)).to.equal(parseEther("0.26"));
            // fund1 current weight: (0.52 / (1 - 0.2) + 0.7) * (1 - 0.2) / 2 = 0.54
            expect(await getWeight(fund1, startWeek + WEEK * 6)).to.equal(parseEther("0.54"));
            expect(await getWeight(fund2, startWeek + WEEK * 6)).to.equal(parseEther("0.2"));
        });

        it("Should inherit previous weights if funds are empty", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 6 + DAY);
            await fund0.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await fund1.mock.currentDay.returns(startWeek + WEEK * 6 + DAY);
            await fund0.mock.historicalTotalShares.returns(0);
            await fund0.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await fund1.mock.historicalTotalShares.returns(0);
            await fund1.mock.historicalNavs.returns(parseEther("1"), 0, 0);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 3);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 4);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 5);
            await chessController.getFundRelativeWeight(fund0.address, startWeek + WEEK * 6);

            expect(await getWeight(fund0, startWeek + WEEK * 3)).to.equal(parseEther("0.7"));
            expect(await getWeight(fund1, startWeek + WEEK * 3)).to.equal(parseEther("0.3"));
            expect(await getWeight(fund2, startWeek + WEEK * 3)).to.equal(0);
            expect(await getWeight(fund0, startWeek + WEEK * 4)).to.equal(parseEther("0.63"));
            expect(await getWeight(fund1, startWeek + WEEK * 4)).to.equal(parseEther("0.27"));
            expect(await getWeight(fund2, startWeek + WEEK * 4)).to.equal(parseEther("0.1"));
            expect(await getWeight(fund0, startWeek + WEEK * 5)).to.equal(parseEther("0.56"));
            expect(await getWeight(fund1, startWeek + WEEK * 5)).to.equal(parseEther("0.24"));
            expect(await getWeight(fund2, startWeek + WEEK * 5)).to.equal(parseEther("0.2"));
            expect(await getWeight(fund0, startWeek + WEEK * 6)).to.equal(parseEther("0.56"));
            expect(await getWeight(fund1, startWeek + WEEK * 6)).to.equal(parseEther("0.24"));
            expect(await getWeight(fund2, startWeek + WEEK * 6)).to.equal(parseEther("0.2"));
        });

        it("Should return zero for unknown address", async function () {
            await advanceBlockAtTime(startWeek + WEEK * 10 + DAY);
            expect(await getWeight(user1, startWeek)).to.equal(0);
            expect(await getWeight(user1, startWeek + WEEK * 3)).to.equal(0);
            expect(await getWeight(chessController, startWeek + WEEK * 5)).to.equal(0);
        });
    });
});
