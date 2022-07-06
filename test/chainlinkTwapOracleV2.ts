import { expect } from "chai";
import { BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
import { deployMockForName } from "./mock";
import { FixtureWalletMap, advanceBlockAtTime, setNextBlockTime } from "./utils";

const EPOCH = 1800; // 30 min
const MIN_MESSAGE_COUNT = 10;
const UPDATE_TYPE_OWNER = 2;
const UPDATE_TYPE_CHAINLINK = 3;

const CHAINLINK_DECIMAL = 10;
const parseChainlink = (value: string) => parseUnits(value, CHAINLINK_DECIMAL);
const CHAINLINK_START_PRICE = parseChainlink("50000");
const START_PRICE = parseEther("50000");

describe("ChainlinkTwapOracleV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startEpoch: number;
        readonly aggregator: MockContract;
        readonly fallbackOracle: MockContract;
        readonly twapOracle: Contract;
        readonly nextRoundID: number;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let owner: Wallet;
    let startEpoch: number;
    let aggregator: MockContract;
    let fallbackOracle: MockContract;
    let twapOracle: Contract;
    let nextRoundID: number;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startEpoch = Math.ceil(startTimestamp / EPOCH) * EPOCH + EPOCH * 2;
        await advanceBlockAtTime(startEpoch - EPOCH / 2);

        const nextRoundID = 123000;
        const aggregator = await deployMockForName(owner, "AggregatorV3Interface");
        await aggregator.mock.decimals.returns(CHAINLINK_DECIMAL);
        await aggregator.mock.latestRoundData.returns(
            nextRoundID - 1,
            CHAINLINK_START_PRICE,
            startTimestamp,
            startTimestamp,
            nextRoundID - 1
        );
        await aggregator.mock.getRoundData
            .withArgs(nextRoundID - 1)
            .returns(
                nextRoundID - 1,
                CHAINLINK_START_PRICE,
                startTimestamp,
                startTimestamp,
                nextRoundID - 1
            );

        const fallbackOracle = await deployMockForName(owner, "ITwapOracle");

        const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracleV2");
        const twapOracle = await ChainlinkTwapOracle.connect(owner).deploy(
            aggregator.address,
            MIN_MESSAGE_COUNT,
            fallbackOracle.address,
            startEpoch,
            "BTC"
        );

        return {
            wallets: { user1, owner },
            startEpoch,
            aggregator,
            fallbackOracle,
            twapOracle: twapOracle.connect(user1),
            nextRoundID,
        };
    }

    async function addRound(price: BigNumberish, timestamp: number): Promise<void> {
        await aggregator.mock.getRoundData
            .withArgs(nextRoundID)
            .returns(nextRoundID, price, timestamp, timestamp, nextRoundID);
        nextRoundID++;
    }

    async function addRounds(price: BigNumberish, timestamp: number): Promise<void> {
        for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
            await addRound(price, timestamp - EPOCH + (EPOCH / MIN_MESSAGE_COUNT) * (i + 1));
        }
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        owner = fixtureData.wallets.owner;
        startEpoch = fixtureData.startEpoch;
        aggregator = fixtureData.aggregator;
        fallbackOracle = fixtureData.fallbackOracle;
        twapOracle = fixtureData.twapOracle;
        nextRoundID = fixtureData.nextRoundID;
    });

    describe("Initialization", function () {
        it("Initialized states", async function () {
            expect(await twapOracle.fallbackTimestamp()).to.equal(startEpoch);
            expect(await twapOracle.startRoundID()).to.equal(nextRoundID - 1);
        });
    });

    describe("update() from Chainlink", function () {
        it("Should revert before the next epoch ends", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH - 10);
            await expect(twapOracle.update(startEpoch + EPOCH)).to.be.revertedWith("Too soon");
        });

        it("Should calculate TWAP", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE.add(parseChainlink("10").mul(i + 1)),
                    startEpoch + (EPOCH / MIN_MESSAGE_COUNT) * (i + 1)
                );
            }
            await addRound(0, 0);
            // The last data point at (startEpoch + EPOCH) has zero weight in this twap calculation
            const twap = START_PRICE.add(
                parseEther("10")
                    .mul(MIN_MESSAGE_COUNT - 1)
                    .div(2)
            );
            await expect(twapOracle.update(startEpoch + EPOCH))
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH, twap, UPDATE_TYPE_CHAINLINK);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(twap);
        });

        it("Should skip old rounds", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            // This round is completely ignored
            await addRound(parseChainlink("50000"), startEpoch - 10);
            // Price in this round is used as the price at the start of the updating epoch
            await addRound(parseChainlink("60000"), startEpoch - 5);
            // Set data points for the second half of the epoch
            for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
                await addRound(parseChainlink("70000"), startEpoch + EPOCH / 2 + i);
            }
            await addRound(0, 0);
            // The last data point at (startEpoch + EPOCH) has zero weight in this twap calculation
            const twap = parseEther("65000");
            await expect(twapOracle.update(startEpoch + EPOCH))
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH, twap, UPDATE_TYPE_CHAINLINK);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(twap);
        });

        it("Should skip if there's not enough data points", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            for (let i = 1; i <= MIN_MESSAGE_COUNT - 1; i++) {
                await addRound(CHAINLINK_START_PRICE, startEpoch + (EPOCH / MIN_MESSAGE_COUNT) * i);
            }
            await addRound(0, 0);
            await expect(twapOracle.update(startEpoch + EPOCH));
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(0);
        });

        it("Should not read rounds after the epoch", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE,
                    startEpoch + (EPOCH / MIN_MESSAGE_COUNT) * (i + 1)
                );
            }
            await addRound(parseChainlink("70000"), startEpoch + EPOCH + 100);
            await addRound(parseChainlink("80000"), startEpoch + EPOCH + 200);
            await addRound(parseChainlink("90000"), startEpoch + EPOCH + 300);
            await twapOracle.update(startEpoch + EPOCH);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(START_PRICE);
        });

        it("Should handle reverts in case of insufficient data points", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await aggregator.mock.getRoundData.withArgs(nextRoundID).reverts();
            await twapOracle.update(startEpoch + EPOCH);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(0);
        });

        it("Should handle reverts in case of sufficient data points", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE,
                    startEpoch + (EPOCH / MIN_MESSAGE_COUNT) * (i + 1)
                );
            }
            await aggregator.mock.getRoundData.withArgs(nextRoundID).reverts();
            await twapOracle.update(startEpoch + EPOCH);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(START_PRICE);
        });

        it("Should accept the twap if the difference from Uniswap is limited", async function () {
            // Observe Uniswap for the first time
            await setNextBlockTime(startEpoch + EPOCH + 1);
            await twapOracle.update(startEpoch + EPOCH);

            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await addRound(CHAINLINK_START_PRICE.div(10).mul(9), startEpoch + EPOCH);
            for (let i = 1; i <= MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE.div(10).mul(9),
                    startEpoch + EPOCH + (EPOCH / MIN_MESSAGE_COUNT) * i
                );
            }
            await addRound(0, 0);
            await expect(twapOracle.update(startEpoch + EPOCH * 2))
                .to.emit(twapOracle, "Update")
                .withArgs(
                    startEpoch + EPOCH * 2,
                    START_PRICE.div(10).mul(9),
                    UPDATE_TYPE_CHAINLINK
                );
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 2)).to.equal(
                START_PRICE.div(10).mul(9)
            );
        });
    });

    describe("updateTwapFromOwner()", async function () {
        beforeEach(async function () {
            // Update an epoch
            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            await twapOracle.update(startEpoch + EPOCH); // First observation
            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await twapOracle.update(startEpoch + EPOCH * 2); // Update epoch (startEpoch + EPOCH * 2)

            twapOracle = twapOracle.connect(owner);
        });

        it("Should reject data if Chainlink has results", async function () {
            await addRounds(CHAINLINK_START_PRICE, startEpoch + EPOCH * 3);
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE)
            ).to.be.revertedWith("Owner cannot overwrite Chainlink result");
        });

        it("Should reject data if not called by owner", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.update(startEpoch + EPOCH * 3); // Skip an epoch
            await expect(
                twapOracle.connect(user1).updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject unaligned timestamp", async function () {
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH - 1, START_PRICE)
            ).to.be.revertedWith("Unaligned timestamp");
        });

        it("Should reject when updating an updated epoch", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE);
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE)
            ).to.be.revertedWith("Owner cannot update an existing epoch");
        });

        it("Should accept valid data", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.update(startEpoch + EPOCH * 3); // Skip an epoch
            await twapOracle.update(startEpoch + EPOCH * 4); // Skip an epoch
            await twapOracle.update(startEpoch + EPOCH * 5); // Skip an epoch

            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE.add(10))
            )
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH * 3, START_PRICE.add(10), UPDATE_TYPE_OWNER);
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 3)).to.equal(START_PRICE.add(10));

            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 4, START_PRICE.add(20))
            )
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH * 4, START_PRICE.add(20), UPDATE_TYPE_OWNER);
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 4)).to.equal(START_PRICE.add(20));
        });
    });

    describe("Fallback oracle", function () {
        it("Should call fallback oracle", async function () {
            await fallbackOracle.mock.getTwap.withArgs(startEpoch).returns(12345);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(12345);
            await fallbackOracle.mock.getTwap.withArgs(startEpoch - EPOCH * 10).returns(6789);
            expect(await twapOracle.getTwap(startEpoch - EPOCH * 10)).to.equal(6789);
        });

        it("Should revert if fallback timestamp is too early", async function () {
            const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracleV2");
            await expect(
                ChainlinkTwapOracle.connect(owner).deploy(
                    aggregator.address,
                    MIN_MESSAGE_COUNT,
                    fallbackOracle.address,
                    startEpoch - 1,
                    "BTC"
                )
            ).to.be.revertedWith("Fallback timestamp too early");
        });

        it("Should work when fallback timestamp is later", async function () {
            await addRounds(CHAINLINK_START_PRICE, startEpoch + EPOCH * 3);
            const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracleV2");
            const newTwapOracle = await ChainlinkTwapOracle.connect(owner).deploy(
                aggregator.address,
                MIN_MESSAGE_COUNT,
                fallbackOracle.address,
                startEpoch + EPOCH * 2,
                "BTC"
            );
            await fallbackOracle.mock.getTwap.withArgs(startEpoch + EPOCH).returns(123);
            await fallbackOracle.mock.getTwap.withArgs(startEpoch + EPOCH * 2).returns(456);
            await fallbackOracle.mock.getTwap.withArgs(startEpoch + EPOCH * 3).returns(789);

            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            await newTwapOracle.update(startEpoch + EPOCH); // First observation
            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await newTwapOracle.update(startEpoch + EPOCH * 2); // Update epoch (startEpoch + EPOCH * 2)
            await advanceBlockAtTime(startEpoch + EPOCH * 3 + 1);
            await newTwapOracle.update(startEpoch + EPOCH * 3); // Update epoch (startEpoch + EPOCH * 3)

            expect(await newTwapOracle.getTwap(startEpoch + EPOCH)).to.equal(123);
            expect(await newTwapOracle.getTwap(startEpoch + EPOCH * 2)).to.equal(456);
            expect(await newTwapOracle.getTwap(startEpoch + EPOCH * 3)).to.equal(START_PRICE);
        });

        it("Should return zero if fallback oracle is zero", async function () {
            const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracleV2");
            const newTwapOracle = await ChainlinkTwapOracle.connect(owner).deploy(
                aggregator.address,
                MIN_MESSAGE_COUNT,
                ethers.constants.AddressZero,
                0,
                "BTC"
            );
            expect(await newTwapOracle.getTwap(startEpoch - EPOCH * 10)).to.equal(0);
        });
    });

    describe("nearestRoundID()", function () {
        const currentID = 42;
        it("Should search for the greatest updatedAt smaller than endTimestamp", async function () {
            await aggregator.mock.getRoundData.withArgs(currentID).returns(0, 0, 0, 2, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 1).returns(0, 0, 0, 3, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 2).returns(0, 0, 0, 5, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 3).returns(0, 0, 0, 7, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 4).returns(0, 0, 0, 11, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 5).returns(0, 0, 0, 13, 0);
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 1)).to.equal(0);
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 2)).to.equal(0);
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 3)).to.equal(
                currentID
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 4)).to.equal(
                currentID + 1
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 5)).to.equal(
                currentID + 1
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 6)).to.equal(
                currentID + 2
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 7)).to.equal(
                currentID + 2
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 8)).to.equal(
                currentID + 3
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 9)).to.equal(
                currentID + 3
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 10)).to.equal(
                currentID + 3
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 11)).to.equal(
                currentID + 3
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 12)).to.equal(
                currentID + 4
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 13)).to.equal(
                currentID + 4
            );
            expect(await twapOracle.nearestRoundID(currentID, currentID + 5, 14)).to.equal(
                currentID + 5
            );
        });
    });
});
