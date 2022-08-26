import { expect } from "chai";
import { BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
import { deployMockForName } from "./mock";
import { HOUR, FixtureWalletMap, advanceBlockAtTime, setNextBlockTime } from "./utils";

const EPOCH = HOUR / 2;
const MIN_MESSAGE_COUNT = 10;
const MESSAGE_EXPIRATION = HOUR * 6;
const UPDATE_TYPE_OWNER = 2;

const CHAINLINK_DECIMAL = 10;
const parseChainlink = (value: string) => parseUnits(value, CHAINLINK_DECIMAL);
const CHAINLINK_START_PRICE = parseChainlink("50000");
const START_PRICE = parseEther("50000");

describe("ChainlinkTwapOracleV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startEpoch: number;
        readonly aggregator: MockContract;
        readonly fund: MockContract;
        readonly twapOracle: Contract;
        readonly firstRoundID: number;
        readonly nextRoundID: number;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let startEpoch: number;
    let aggregator: MockContract;
    let fund: MockContract;
    let twapOracle: Contract;
    let firstRoundID: number;
    let nextRoundID: number;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startEpoch = Math.ceil(startTimestamp / EPOCH) * EPOCH + EPOCH * 10;
        await advanceBlockAtTime(startEpoch - EPOCH * 2);

        const aggregator = await deployMockForName(owner, "AggregatorV3Interface");
        await aggregator.mock.decimals.returns(CHAINLINK_DECIMAL);
        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.getRebalanceTimestamp.returns(0);

        const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracleV2");
        const twapOracle = await ChainlinkTwapOracle.connect(owner).deploy(
            aggregator.address,
            MIN_MESSAGE_COUNT,
            MESSAGE_EXPIRATION,
            "BTC",
            fund.address
        );

        const firstRoundID = 123000;
        // Add a round before the epoch
        await aggregator.mock.getRoundData
            .withArgs(firstRoundID)
            .returns(
                firstRoundID,
                CHAINLINK_START_PRICE,
                startEpoch - EPOCH * 1.5,
                startEpoch - EPOCH * 1.5,
                firstRoundID
            );
        let nextRoundID = firstRoundID + 1;
        // Add rounds at the epoch start and in the epoch
        for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
            const price = CHAINLINK_START_PRICE.add(parseChainlink("10").mul(i));
            const timestamp = startEpoch - EPOCH + (EPOCH / MIN_MESSAGE_COUNT) * i;
            await aggregator.mock.getRoundData
                .withArgs(nextRoundID)
                .returns(nextRoundID, price, timestamp, timestamp, nextRoundID);
            if (i == MIN_MESSAGE_COUNT - 1) {
                await aggregator.mock.latestRoundData.returns(
                    nextRoundID,
                    price,
                    timestamp,
                    timestamp,
                    nextRoundID
                );
            }
            nextRoundID++;
        }

        return {
            wallets: { user1, owner },
            startEpoch,
            aggregator,
            fund,
            twapOracle,
            firstRoundID,
            nextRoundID,
        };
    }

    async function addRound(price: BigNumberish, timestamp: number): Promise<void> {
        await aggregator.mock.getRoundData
            .withArgs(nextRoundID)
            .returns(nextRoundID, price, timestamp, timestamp, nextRoundID);
        nextRoundID++;
    }

    async function updateLatestRound(): Promise<void> {
        const ret = await aggregator.getRoundData(nextRoundID - 1);
        await aggregator.mock.latestRoundData.returns(ret[0], ret[1], ret[2], ret[3], ret[4]);
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        startEpoch = fixtureData.startEpoch;
        aggregator = fixtureData.aggregator;
        fund = fixtureData.fund;
        twapOracle = fixtureData.twapOracle;
        firstRoundID = fixtureData.firstRoundID;
        nextRoundID = fixtureData.nextRoundID;
    });

    describe("getTwap()", function () {
        const INIT_TWAP = START_PRICE.add(
            parseEther("10")
                .mul(MIN_MESSAGE_COUNT - 1)
                .div(2)
        );

        it("Should revert if timestamp is in the future", async function () {
            await advanceBlockAtTime(startEpoch - 10);
            await expect(twapOracle.getTwap(startEpoch)).to.be.revertedWith("Too soon");
        });

        it("Should work with no round after the epoch", async function () {
            await advanceBlockAtTime(startEpoch + 1);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(INIT_TWAP);
        });

        it("Should work with a round at the epoch end", async function () {
            await addRound(CHAINLINK_START_PRICE.mul(2), startEpoch);
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + 1);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(INIT_TWAP);
        });

        it("Should work with a few rounds after the epoch", async function () {
            for (let i = 0; i < 5; i++) {
                await addRound(CHAINLINK_START_PRICE.mul(2), startEpoch + i * 5 + 10);
            }
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + 100);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(INIT_TWAP);
        });

        it("Should work with no round at the epoch start but one before", async function () {
            // Move the epoch start round a bit earlier and change its price
            await aggregator.mock.getRoundData
                .withArgs(firstRoundID + 1)
                .returns(
                    firstRoundID + 1,
                    CHAINLINK_START_PRICE.add(parseChainlink("6000")),
                    startEpoch - EPOCH - 100,
                    startEpoch - EPOCH - 100,
                    firstRoundID + 1
                );
            // Add a new round before the epoch end so that there are still enough rounds in the epoch
            const lastRoundPrice = (await aggregator.getRoundData(nextRoundID - 1))[1];
            await addRound(lastRoundPrice, startEpoch - 1);
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + 1);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(
                INIT_TWAP.add(parseEther("6000").div(MIN_MESSAGE_COUNT))
            );
        });

        it("Should work with no round at or before the epoch start", async function () {
            // Remove the epoch start round
            await aggregator.mock.getRoundData.withArgs(firstRoundID + 1).returns(0, 0, 0, 0, 0);
            // Add a new round before the epoch end so that there are still enough rounds in the epoch
            const lastRoundPrice = (await aggregator.getRoundData(nextRoundID - 1))[1];
            await addRound(lastRoundPrice, startEpoch - 1);
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + 1);
            // Weight of the next round of the removed one is doubled
            expect(await twapOracle.getTwap(startEpoch)).to.equal(
                INIT_TWAP.add(parseEther("10").div(MIN_MESSAGE_COUNT))
            );
        });

        it("Should ignore invalid round and all rounds before it", async function () {
            // Make the second round in the epoch invalid
            await aggregator.mock.getRoundData
                .withArgs(firstRoundID + 2)
                .returns(
                    firstRoundID + 2,
                    CHAINLINK_START_PRICE,
                    startEpoch,
                    startEpoch,
                    firstRoundID + 2
                );
            // Add two new rounds before the epoch end so that there are still enough rounds in the epoch
            const lastRoundPrice = (await aggregator.getRoundData(nextRoundID - 1))[1];
            await addRound(lastRoundPrice, startEpoch - 2);
            await addRound(lastRoundPrice, startEpoch - 1);
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + 1);
            // Weight of the third round of the removed one is trippled
            expect(await twapOracle.getTwap(startEpoch)).to.equal(
                INIT_TWAP.add(parseEther("30").div(MIN_MESSAGE_COUNT))
            );
        });

        it("Should return zero if there's not enough data points", async function () {
            // Move the epoch start round earlier
            await aggregator.mock.getRoundData
                .withArgs(firstRoundID + 1)
                .returns(
                    firstRoundID + 1,
                    CHAINLINK_START_PRICE,
                    startEpoch - EPOCH - MESSAGE_EXPIRATION - 1,
                    startEpoch - EPOCH - MESSAGE_EXPIRATION - 1,
                    firstRoundID + 1
                );
            await advanceBlockAtTime(startEpoch + 1);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(0);
        });

        it("Should use the last round before the epoch start if it's not too old", async function () {
            // Add a new round before the epoch end so that there are still enough rounds in the epoch
            const lastRoundPrice = (await aggregator.getRoundData(nextRoundID - 1))[1];
            await addRound(lastRoundPrice, startEpoch - 1);
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + 1);
            // Move the epoch start round earlier
            await aggregator.mock.getRoundData
                .withArgs(firstRoundID + 1)
                .returns(
                    firstRoundID + 1,
                    CHAINLINK_START_PRICE,
                    startEpoch - EPOCH - MESSAGE_EXPIRATION,
                    startEpoch - EPOCH - MESSAGE_EXPIRATION,
                    firstRoundID + 1
                );
            expect(await twapOracle.getTwap(startEpoch)).to.equal(INIT_TWAP);
            // Move this round even earlier so that it is not used any more
            await aggregator.mock.getRoundData
                .withArgs(firstRoundID + 1)
                .returns(
                    firstRoundID + 1,
                    CHAINLINK_START_PRICE,
                    startEpoch - EPOCH - MESSAGE_EXPIRATION - 1,
                    startEpoch - EPOCH - MESSAGE_EXPIRATION - 1,
                    firstRoundID + 1
                );
            // Weight of the next round of the moved one is doubled
            expect(await twapOracle.getTwap(startEpoch)).to.equal(
                INIT_TWAP.add(parseEther("10").div(MIN_MESSAGE_COUNT))
            );
        });

        it("Should handle reverts in case of insufficient data points", async function () {
            // Make the second round in the epoch revert
            await aggregator.mock.getRoundData.withArgs(firstRoundID + 2).reverts();
            await advanceBlockAtTime(startEpoch + 1);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(0);
        });

        it("Should handle reverts in case of sufficient data points", async function () {
            // Make the second round in the epoch revert
            await aggregator.mock.getRoundData.withArgs(firstRoundID + 2).reverts();
            // Add two new rounds before the epoch end so that there are still enough rounds in the epoch
            const lastRoundPrice = (await aggregator.getRoundData(nextRoundID - 1))[1];
            await addRound(lastRoundPrice, startEpoch - 2);
            await addRound(lastRoundPrice, startEpoch - 1);
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + 1);
            // Weight of the third round of the removed one is trippled
            expect(await twapOracle.getTwap(startEpoch)).to.equal(
                INIT_TWAP.add(parseEther("30").div(MIN_MESSAGE_COUNT))
            );
        });

        it("Should work for an epoch long in the past", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(INIT_TWAP);

            await addRound(CHAINLINK_START_PRICE.mul(2), startEpoch);
            await updateLatestRound();
            expect(await twapOracle.getTwap(startEpoch)).to.equal(INIT_TWAP);

            for (let i = 0; i < 10; i++) {
                await addRound(CHAINLINK_START_PRICE.mul(3), startEpoch + EPOCH * i);
            }
            await updateLatestRound();
            expect(await twapOracle.getTwap(startEpoch)).to.equal(INIT_TWAP);
        });

        it("Should return zero for an ancient epoch due to failed binary search", async function () {
            nextRoundID *= 10;
            await addRound(CHAINLINK_START_PRICE, startEpoch + EPOCH * 1000);
            await updateLatestRound();
            await advanceBlockAtTime(startEpoch + EPOCH * 1000);
            expect(await twapOracle.getTwap(startEpoch)).to.equal(0);
        });
    });

    describe("getLatest()", function () {
        beforeEach(async function () {
            await addRound(parseChainlink("12345"), startEpoch);
            await updateLatestRound();
        });

        it("Should return the latest price", async function () {
            await advanceBlockAtTime(startEpoch + 1);
            expect(await twapOracle.getLatest()).to.equal(parseEther("12345"));
        });

        it("Should revert if the price is too old", async function () {
            await advanceBlockAtTime(startEpoch + MESSAGE_EXPIRATION);
            expect(await twapOracle.getLatest()).to.equal(parseEther("12345"));
            await advanceBlockAtTime(startEpoch + MESSAGE_EXPIRATION + 1);
            await expect(twapOracle.getLatest()).to.be.revertedWith("Stale price oracle");
        });

        it("Should revert if queried at the same time when a rebalance is triggered", async function () {
            await setNextBlockTime(startEpoch + 100);
            await fund.mock.getRebalanceTimestamp.returns(startEpoch + 100);
            await expect(twapOracle.getLatest()).to.be.revertedWith("Rebalance in the same block");
        });
    });

    describe("updateTwapFromOwner()", async function () {
        it("Should revert if not called by owner", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await expect(
                twapOracle.connect(user1).updateTwapFromOwner(startEpoch + EPOCH, START_PRICE)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject unaligned timestamp", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH - 1, START_PRICE)
            ).to.be.revertedWith("Unaligned timestamp");
        });

        it("Should reject recent epoch", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 9, START_PRICE)
            ).to.be.revertedWith("Not ready for owner");
        });

        it("Should revert if Chainlink has results", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch, START_PRICE)
            ).to.be.revertedWith("Owner cannot overwrite Chainlink result");
        });

        it("Should reject when updating an updated epoch", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.updateTwapFromOwner(startEpoch + EPOCH, START_PRICE);
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH, START_PRICE)
            ).to.be.revertedWith("Owner cannot update an existing epoch");
        });

        it("Should accept valid data", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await expect(twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE))
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH * 3, START_PRICE, UPDATE_TYPE_OWNER);
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 3)).to.equal(START_PRICE);
        });
    });
});
