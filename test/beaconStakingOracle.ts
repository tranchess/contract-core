import { expect } from "chai";
import { BigNumberish, constants, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
import { deployMockForName } from "./mock";
import { WEEK, FixtureWalletMap, advanceBlockAtTime } from "./utils";

const EPOCH_INTERVAL = 225;
const SECONDS_PER_EPOCH = 384;
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
        await advanceBlockAtTime(genesisTime + EPOCH_INTERVAL * SECONDS_PER_EPOCH);

        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.getTotalUnderlying.returns(0);

        const strategy = await deployMockForName(owner, "EthStakingStrategy");
        await strategy.mock.fund.returns(fund.address);

        const BeaconStakingOracle = await ethers.getContractFactory("BeaconStakingOracle");
        const stakingOracle = await BeaconStakingOracle.connect(owner).deploy(
            strategy.address,
            EPOCH_INTERVAL,
            SECONDS_PER_EPOCH,
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

    describe("addMember()", function () {
        it("Should revert if adding zero address as member", async function () {
            await expect(stakingOracle.addMember(constants.AddressZero, QUORUM)).to.be.revertedWith(
                "Invalid address"
            );
        });

        it("Should revert if adding an existing member", async function () {
            await stakingOracle.addMember(user1.address, QUORUM);
            await expect(stakingOracle.addMember(user1.address, QUORUM)).to.be.revertedWith(
                "Already a member"
            );
        });

        it("Should add oracle member", async function () {
            await expect(stakingOracle.addMember(user1.address, QUORUM))
                .to.emit(stakingOracle, "MemberAdded")
                .withArgs(user1.address);
        });
    });

    describe("removeMember()", function () {
        it("Should revert if removing an non-member address", async function () {
            await expect(stakingOracle.removeMember(user1.address, QUORUM)).to.be.revertedWith(
                "Not a member"
            );
        });

        it("Should remove oracle member", async function () {
            await stakingOracle.addMember(user1.address, QUORUM);
            await expect(stakingOracle.removeMember(user1.address, QUORUM))
                .to.emit(stakingOracle, "MemberRemoved")
                .withArgs(user1.address);
            expect(await stakingOracle.nonce()).to.equal(1);
        });
    });

    describe("batchReport()", function () {
        function hashPack(
            operatorDatas: Array<Array<BigNumberish>>,
            finalizationCount: BigNumberish,
            nonce: BigNumberish
        ): any {
            return ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["tuple(uint256,uint256,uint256,uint256)[]", "uint256", "uint256"],
                    [operatorDatas, finalizationCount, nonce]
                )
            );
        }

        beforeEach(async function () {
            await stakingOracle.addMember(user1.address, QUORUM);
            await stakingOracle.addMember(user2.address, QUORUM);
            await stakingOracle.addMember(user3.address, QUORUM);
        });

        it("Should revert if reporting with stable epoch", async function () {
            await strategy.mock.batchReport.returns();
            await stakingOracle
                .connect(user1)
                .batchReport(
                    EPOCH_INTERVAL,
                    [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]],
                    0
                );
            await stakingOracle
                .connect(user2)
                .batchReport(
                    EPOCH_INTERVAL,
                    [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]],
                    0
                );
            await expect(
                stakingOracle
                    .connect(user1)
                    .batchReport(
                        EPOCH_INTERVAL,
                        [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]],
                        0
                    )
            ).to.be.revertedWith("Invalid epoch");
        });

        it("Should revert if reporting twice", async function () {
            await strategy.mock.batchReport.returns();
            await stakingOracle
                .connect(user1)
                .batchReport(
                    EPOCH_INTERVAL,
                    [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]],
                    0
                );
            await expect(
                stakingOracle
                    .connect(user1)
                    .batchReport(
                        EPOCH_INTERVAL,
                        [[0, parseUnits("2", 18), 10, parseUnits("1", 18)]],
                        0
                    )
            ).to.be.revertedWith("Already reported");
        });

        it("Should revert if jump to an invalid epoch", async function () {
            await expect(
                stakingOracle
                    .connect(user1)
                    .batchReport(1, [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]], 0)
            ).to.be.revertedWith("Invalid epoch");
        });

        it("Should invalidate previous reports if a oracle member is removed", async function () {
            let nonce: number = await stakingOracle.nonce();
            await expect(
                stakingOracle
                    .connect(user1)
                    .batchReport(
                        EPOCH_INTERVAL,
                        [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]],
                        0
                    )
            )
                .to.emit(stakingOracle, "BeaconReported")
                .withArgs(
                    EPOCH_INTERVAL,
                    hashPack([[0, parseUnits("1", 18), 10, parseUnits("1", 18)]], 0, nonce),
                    user1.address
                );

            await expect(stakingOracle.removeMember(user1.address, QUORUM))
                .to.emit(stakingOracle, "MemberRemoved")
                .withArgs(user1.address);

            nonce++;
            await expect(
                stakingOracle
                    .connect(user2)
                    .batchReport(
                        EPOCH_INTERVAL,
                        [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]],
                        0
                    )
            )
                .to.emit(stakingOracle, "BeaconReported")
                .withArgs(
                    EPOCH_INTERVAL,
                    hashPack([[0, parseUnits("1", 18), 10, parseUnits("1", 18)]], 0, nonce),
                    user2.address
                );

            await strategy.mock.batchReport
                .withArgs(EPOCH_INTERVAL, [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]], 0)
                .returns();

            await expect(
                stakingOracle
                    .connect(user3)
                    .batchReport(
                        EPOCH_INTERVAL,
                        [[0, parseUnits("1", 18), 10, parseUnits("1", 18)]],
                        0
                    )
            )
                .to.emit(stakingOracle, "BeaconReported")
                .withArgs(
                    EPOCH_INTERVAL,
                    hashPack([[0, parseUnits("1", 18), 10, parseUnits("1", 18)]], 0, nonce),
                    user3.address
                );
        });
    });
});
