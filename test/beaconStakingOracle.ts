import { expect } from "chai";
import { constants, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
import { deployMockForName } from "./mock";
import { WEEK, FixtureWalletMap, advanceBlockAtTime } from "./utils";

const EPOCHS_PER_FRAME = 225;
const SLOTS_PER_EPOCH = 32;
const SECONDS_PER_SLOT = 12;
const ANNUAL_MAX_CHANGE = parseEther("0.5");
const QUORUM = 2;

describe("BeaconStakingOracle", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly strategy: MockContract;
        readonly stakingOracle: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let user3: Wallet;
    let strategy: MockContract;
    let stakingOracle: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const genesisTime = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK * 10;
        await advanceBlockAtTime(
            genesisTime + EPOCHS_PER_FRAME * SLOTS_PER_EPOCH * SECONDS_PER_SLOT
        );

        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.getTotalUnderlying.returns(0);

        const strategy = await deployMockForName(owner, "EthStakingStrategy");
        await strategy.mock.fund.returns(fund.address);

        const BeaconStakingOracle = await ethers.getContractFactory("BeaconStakingOracle");
        const stakingOracle = await BeaconStakingOracle.connect(owner).deploy(
            strategy.address,
            EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
            SECONDS_PER_SLOT,
            genesisTime,
            ANNUAL_MAX_CHANGE
        );

        return {
            wallets: { user1, user2, user3, owner },
            strategy,
            stakingOracle,
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        user3 = fixtureData.wallets.user3;
        strategy = fixtureData.strategy;
        stakingOracle = fixtureData.stakingOracle;
    });

    describe("addOracleMember()", function () {
        it("Should revert if adding zero address as member", async function () {
            await expect(
                stakingOracle.addOracleMember(constants.AddressZero, QUORUM)
            ).to.be.revertedWith("Invalid address");
        });

        it("Should revert if adding an existing member", async function () {
            await stakingOracle.addOracleMember(user1.address, QUORUM);
            await expect(stakingOracle.addOracleMember(user1.address, QUORUM)).to.be.revertedWith(
                "Already a member"
            );
        });

        it("Should add oracle member", async function () {
            await expect(stakingOracle.addOracleMember(user1.address, QUORUM))
                .to.emit(stakingOracle, "MemberAdded")
                .withArgs(user1.address);
        });
    });

    describe("removeOracleMember()", function () {
        it("Should revert if removing an non-member address", async function () {
            await expect(
                stakingOracle.removeOracleMember(user1.address, QUORUM)
            ).to.be.revertedWith("Not a member");
        });

        it("Should remove oracle member", async function () {
            await stakingOracle.addOracleMember(user1.address, QUORUM);
            await expect(stakingOracle.removeOracleMember(user1.address, QUORUM))
                .to.emit(stakingOracle, "MemberRemoved")
                .withArgs(user1.address);
            expect(await stakingOracle.nonce()).to.equal(1);
        });
    });

    describe("batchReport()", function () {
        beforeEach(async function () {
            await stakingOracle.addOracleMember(user1.address, QUORUM);
            await stakingOracle.addOracleMember(user2.address, QUORUM);
            await stakingOracle.addOracleMember(user3.address, QUORUM);
        });

        it("Should revert if reporting with stable epoch", async function () {
            await strategy.mock.batchReport.returns();
            await stakingOracle
                .connect(user1)
                .batchReport(EPOCHS_PER_FRAME * SLOTS_PER_EPOCH, [0], [parseUnits("1", 18)], [10]);
            await stakingOracle
                .connect(user2)
                .batchReport(EPOCHS_PER_FRAME * SLOTS_PER_EPOCH, [0], [parseUnits("1", 18)], [10]);
            await expect(
                stakingOracle
                    .connect(user1)
                    .batchReport(
                        EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                        [0],
                        [parseUnits("1", 18)],
                        [10]
                    )
            ).to.be.revertedWith("Invalid epoch");
        });

        it("Should revert if reporting twice", async function () {
            await strategy.mock.batchReport.returns();
            await stakingOracle
                .connect(user1)
                .batchReport(EPOCHS_PER_FRAME * SLOTS_PER_EPOCH, [0], [parseUnits("1", 18)], [10]);
            await expect(
                stakingOracle
                    .connect(user1)
                    .batchReport(
                        EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                        [0],
                        [parseUnits("2", 18)],
                        [10]
                    )
            ).to.be.revertedWith("Already reported");
        });

        it("Should revert if jump to an invalid epoch", async function () {
            await expect(
                stakingOracle.connect(user1).batchReport(1, [0], [parseUnits("1", 18)], [10])
            ).to.be.revertedWith("Invalid epoch");
        });

        it("Should invalidate previous reports if a oracle member is removed", async function () {
            await expect(
                stakingOracle
                    .connect(user1)
                    .batchReport(
                        EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                        [0],
                        [parseUnits("1", 18)],
                        [10]
                    )
            )
                .to.emit(stakingOracle, "BeaconReported")
                .withArgs(
                    EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                    [0],
                    [parseUnits("1", 18)],
                    [10],
                    user1.address
                );

            await expect(stakingOracle.removeOracleMember(user1.address, QUORUM))
                .to.emit(stakingOracle, "MemberRemoved")
                .withArgs(user1.address);

            await expect(
                stakingOracle
                    .connect(user2)
                    .batchReport(
                        EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                        [0],
                        [parseUnits("1", 18)],
                        [10]
                    )
            )
                .to.emit(stakingOracle, "BeaconReported")
                .withArgs(
                    EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                    [0],
                    [parseUnits("1", 18)],
                    [10],
                    user2.address
                );

            await strategy.mock.batchReport
                .withArgs(EPOCHS_PER_FRAME * SLOTS_PER_EPOCH, [0], [parseUnits("1", 18)], [10])
                .returns();

            await expect(
                stakingOracle
                    .connect(user3)
                    .batchReport(
                        EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                        [0],
                        [parseUnits("1", 18)],
                        [10]
                    )
            )
                .to.emit(stakingOracle, "BeaconReported")
                .withArgs(
                    EPOCHS_PER_FRAME * SLOTS_PER_EPOCH,
                    [0],
                    [parseUnits("1", 18)],
                    [10],
                    user3.address
                );
        });
    });
});
