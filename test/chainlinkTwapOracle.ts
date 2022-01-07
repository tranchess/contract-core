import { expect } from "chai";
import { BigNumber, BigNumberish, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
const parseUsdc = (value: string) => parseUnits(value, 6);
import { deployMockForName } from "./mock";
import { FixtureWalletMap, advanceBlockAtTime, setNextBlockTime } from "./utils";

const EPOCH = 1800; // 30 min
const MIN_MESSAGE_COUNT = 10;
const MAX_SWAP_DELAY = 15 * 60;
const UPDATE_TYPE_OWNER = 2;
const UPDATE_TYPE_CHAINLINK = 3;
const UPDATE_TYPE_UNISWAP_V2 = 4;

const CHAINLINK_DECIMAL = 10;
const parseChainlink = (value: string) => parseUnits(value, CHAINLINK_DECIMAL);
const CHAINLINK_START_PRICE = parseChainlink("50000");
const SWAP_RESERVE_BTC = parseBtc("1");
const SWAP_RESERVE_USDC = parseUsdc("50000");
const START_PRICE = parseEther("50000");
const BIT_112 = BigNumber.from(1).shl(112);

describe("ChainlinkTwapOracle", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startEpoch: number;
        readonly aggregator: MockContract;
        readonly btc: Contract;
        readonly usdc: Contract;
        readonly swap: MockContract;
        readonly twapOracle: Contract;
        readonly nextRoundID: number;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let owner: Wallet;
    let startEpoch: number;
    let aggregator: MockContract;
    let btc: Contract;
    let usdc: Contract;
    let swap: MockContract;
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

        const MockToken = await ethers.getContractFactory("MockToken");
        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        const usdc = await MockToken.connect(owner).deploy("USD Coin", "USDC", 6);

        const swap = await deployMockForName(owner, "IUniswapV2Pair");
        await swap.mock.token0.returns(btc.address);
        await swap.mock.token1.returns(usdc.address);
        await swap.mock.price0CumulativeLast.returns(0);
        await swap.mock.price1CumulativeLast.returns(0);
        await swap.mock.getReserves.returns(SWAP_RESERVE_BTC, SWAP_RESERVE_USDC, startTimestamp);

        const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracle");
        const twapOracle = await ChainlinkTwapOracle.connect(owner).deploy(
            aggregator.address,
            swap.address,
            "BTC"
        );

        return {
            wallets: { user1, owner },
            startEpoch,
            aggregator,
            btc,
            usdc,
            swap,
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

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        owner = fixtureData.wallets.owner;
        startEpoch = fixtureData.startEpoch;
        aggregator = fixtureData.aggregator;
        btc = fixtureData.btc;
        usdc = fixtureData.usdc;
        swap = fixtureData.swap;
        twapOracle = fixtureData.twapOracle;
        nextRoundID = fixtureData.nextRoundID;
    });

    describe("Initialization", function () {
        it("Initialized states", async function () {
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch);
            expect(await twapOracle.lastRoundID()).to.equal(nextRoundID - 1);
            expect(await twapOracle.lastSwapTimestamp()).to.equal(0);
        });

        it("Should check Uniswap token symbol", async function () {
            const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracle");
            await expect(
                ChainlinkTwapOracle.deploy(aggregator.address, swap.address, "OTHERSYMBOL")
            ).to.be.revertedWith("Symbol mismatch");
        });
    });

    describe("update() from Chainlink", function () {
        it("Should revert before the next epoch ends", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH - 10);
            await expect(twapOracle.update()).to.be.revertedWith("Too soon");
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
            await expect(twapOracle.update())
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH, twap, UPDATE_TYPE_CHAINLINK);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(twap);
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH);
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
            await expect(twapOracle.update())
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
            await expect(twapOracle.update())
                .to.emit(twapOracle, "SkipMissingData")
                .withArgs(startEpoch + EPOCH);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(0);
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH);
        });

        it("Should not read rounds after the epoch", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE,
                    startEpoch + (EPOCH / MIN_MESSAGE_COUNT) * (i + 1)
                );
            }
            const lastRoundID = nextRoundID - 1;
            await addRound(parseChainlink("70000"), startEpoch + EPOCH + 100);
            await addRound(parseChainlink("80000"), startEpoch + EPOCH + 200);
            await addRound(parseChainlink("90000"), startEpoch + EPOCH + 300);
            await twapOracle.update();
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(START_PRICE);
            expect(await twapOracle.lastRoundID()).to.equal(lastRoundID);
        });

        it("Should handle reverts in case of insufficient data points", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await aggregator.mock.getRoundData.withArgs(nextRoundID).reverts();
            await twapOracle.update();
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(0);
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH);
            expect(await twapOracle.lastRoundID()).to.equal(nextRoundID - 1);
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
            await twapOracle.update();
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(START_PRICE);
            expect(await twapOracle.lastRoundID()).to.equal(nextRoundID - 1);
        });

        it("Should skip if result is too small comparing against Uniswap", async function () {
            // Observe Uniswap for the first time
            await setNextBlockTime(startEpoch + EPOCH + 1);
            await twapOracle.update();

            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await addRound(CHAINLINK_START_PRICE.div(10).mul(8), startEpoch + EPOCH);
            for (let i = 1; i <= MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE.div(10).mul(8),
                    startEpoch + EPOCH + (EPOCH / MIN_MESSAGE_COUNT) * i
                );
            }
            await expect(twapOracle.update())
                .to.emit(twapOracle, "SkipDeviation")
                .withArgs(startEpoch + EPOCH * 2, START_PRICE.div(10).mul(8), START_PRICE);
        });

        it("Should skip if result is too large comparing against Uniswap", async function () {
            // Observe Uniswap for the first time
            await setNextBlockTime(startEpoch + EPOCH + 1);
            await twapOracle.update();

            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await addRound(CHAINLINK_START_PRICE.div(10).mul(12), startEpoch + EPOCH);
            for (let i = 1; i <= MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE.div(10).mul(12),
                    startEpoch + EPOCH + (EPOCH / MIN_MESSAGE_COUNT) * i
                );
            }
            await expect(twapOracle.update())
                .to.emit(twapOracle, "SkipDeviation")
                .withArgs(startEpoch + EPOCH * 2, START_PRICE.div(10).mul(12), START_PRICE);
        });

        it("Should accept the twap if the difference from Uniswap is limited", async function () {
            // Observe Uniswap for the first time
            await setNextBlockTime(startEpoch + EPOCH + 1);
            await twapOracle.update();

            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await addRound(CHAINLINK_START_PRICE.div(10).mul(9), startEpoch + EPOCH);
            for (let i = 1; i <= MIN_MESSAGE_COUNT; i++) {
                await addRound(
                    CHAINLINK_START_PRICE.div(10).mul(9),
                    startEpoch + EPOCH + (EPOCH / MIN_MESSAGE_COUNT) * i
                );
            }
            await addRound(0, 0);
            await expect(twapOracle.update())
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

    describe("fastForwardRoundID()", function () {
        it("Should only be called by owner", async function () {
            await expect(twapOracle.fastForwardRoundID(nextRoundID + 100)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should revert if the new ID is not greater than the old", async function () {
            await expect(
                twapOracle.connect(owner).fastForwardRoundID(nextRoundID - 100)
            ).to.be.revertedWith("Round ID too low");
            await expect(
                twapOracle.connect(owner).fastForwardRoundID(nextRoundID - 1)
            ).to.be.revertedWith("Round ID too low");
        });

        it("Should revert if the new round is older than the old", async function () {
            await addRound(CHAINLINK_START_PRICE, startEpoch - EPOCH * 100);
            await expect(
                twapOracle.connect(owner).fastForwardRoundID(nextRoundID - 1)
            ).to.be.revertedWith("Invalid round timestamp");
            await expect(
                twapOracle.connect(owner).fastForwardRoundID(nextRoundID + 100)
            ).to.be.revertedWith("Invalid round timestamp");
        });

        it("Should revert if the new round is newer than the start of the next epoch", async function () {
            await addRound(CHAINLINK_START_PRICE, startEpoch + 1);
            await expect(
                twapOracle.connect(owner).fastForwardRoundID(nextRoundID - 1)
            ).to.be.revertedWith("Round too new");
        });

        it("Should update the last round ID", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.update(); // Skip the first epoch
            await addRound(parseChainlink("10000"), startEpoch + EPOCH - 400);
            await addRound(parseChainlink("20000"), startEpoch + EPOCH - 300);
            await addRound(parseChainlink("30000"), startEpoch + EPOCH - 200);
            await addRound(parseChainlink("40000"), startEpoch + EPOCH - 100);
            await twapOracle.connect(owner).fastForwardRoundID(nextRoundID - 2);
            expect(await twapOracle.lastRoundID()).to.equal(nextRoundID - 2);

            // Fill the second half with data points at price 50000
            for (let i = 0; i < MIN_MESSAGE_COUNT; i++) {
                await addRound(parseChainlink("50000"), startEpoch + EPOCH + EPOCH / 2 + i);
            }
            await twapOracle.update();
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 2)).to.equal(parseEther("45000"));
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH * 2);
            expect(await twapOracle.lastRoundID()).to.equal(nextRoundID - 1);
        });
    });

    describe("update() from Uniswap", function () {
        it("Should store the observation", async function () {
            await swap.mock.getReserves.returns(
                SWAP_RESERVE_BTC,
                SWAP_RESERVE_USDC,
                startEpoch + EPOCH
            );
            await setNextBlockTime(startEpoch + EPOCH + 123);
            await twapOracle.update();
            expect(await twapOracle.lastSwapTimestamp()).to.equal(startEpoch + EPOCH + 123);
            expect(await twapOracle.lastSwapCumulativePrice()).to.equal(
                SWAP_RESERVE_USDC.mul(BIT_112).div(SWAP_RESERVE_BTC).mul(123)
            );
        });

        it("Should not store the observation if it's too late", async function () {
            await swap.mock.getReserves.returns(
                SWAP_RESERVE_BTC,
                SWAP_RESERVE_USDC,
                startEpoch + EPOCH
            );
            await setNextBlockTime(startEpoch + EPOCH + MAX_SWAP_DELAY + 1);
            await twapOracle.update();
            expect(await twapOracle.lastSwapTimestamp()).to.equal(0);
            expect(await twapOracle.lastSwapCumulativePrice()).to.equal(0);
        });

        it("Should calculate TWAP using two observations", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            await twapOracle.update(); // First observation
            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await expect(twapOracle.update())
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH * 2, START_PRICE, UPDATE_TYPE_UNISWAP_V2);
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 2)).to.equal(START_PRICE);
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH * 2);
        });

        it("Should calculate TWAP when both observations are just in time", async function () {
            await setNextBlockTime(startEpoch + EPOCH + MAX_SWAP_DELAY);
            await twapOracle.update(); // First observation
            await setNextBlockTime(startEpoch + EPOCH * 2 + MAX_SWAP_DELAY);
            await expect(twapOracle.update())
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH * 2, START_PRICE, UPDATE_TYPE_UNISWAP_V2);
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 2)).to.equal(START_PRICE);
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH * 2);
        });

        it("Should not use Uniswap data when the first observation is late", async function () {
            await setNextBlockTime(startEpoch + EPOCH + MAX_SWAP_DELAY + 1);
            await twapOracle.update(); // First observation
            await setNextBlockTime(startEpoch + EPOCH * 2 + MAX_SWAP_DELAY);
            await expect(twapOracle.update())
                .to.emit(twapOracle, "SkipMissingData")
                .withArgs(startEpoch + EPOCH * 2);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(0);
        });

        it("Should not use Uniswap data when the second observation is late", async function () {
            await setNextBlockTime(startEpoch + EPOCH + MAX_SWAP_DELAY);
            await twapOracle.update(); // First observation
            await setNextBlockTime(startEpoch + EPOCH * 2 + MAX_SWAP_DELAY + 1);
            await expect(twapOracle.update())
                .to.emit(twapOracle, "SkipMissingData")
                .withArgs(startEpoch + EPOCH * 2);
            expect(await twapOracle.getTwap(startEpoch + EPOCH)).to.equal(0);
        });

        it("Should calculate TWAP when price changes in the epoch", async function () {
            await swap.mock.getReserves.returns(
                SWAP_RESERVE_BTC,
                SWAP_RESERVE_USDC,
                startEpoch + EPOCH
            );
            await setNextBlockTime(startEpoch + EPOCH + 60);
            await twapOracle.update(); // First observation

            // The price doubles.
            await swap.mock.getReserves.returns(
                SWAP_RESERVE_BTC,
                SWAP_RESERVE_USDC.mul(2),
                startEpoch + EPOCH + EPOCH / 2 + 60
            );
            await swap.mock.price0CumulativeLast.returns(
                SWAP_RESERVE_USDC.mul(BIT_112)
                    .div(SWAP_RESERVE_BTC)
                    .mul(EPOCH / 2 + 60)
            );
            await swap.mock.price1CumulativeLast.returns(
                SWAP_RESERVE_BTC.mul(BIT_112)
                    .div(SWAP_RESERVE_USDC)
                    .mul(EPOCH / 2 + 60)
            );

            await setNextBlockTime(startEpoch + EPOCH * 2 + 60);
            await twapOracle.update();
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 2)).to.equal(
                START_PRICE.mul(3).div(2)
            );
        });

        it("Should interpret Uniswap data when the pair tokens are reversed", async function () {
            const newSwap = await deployMockForName(owner, "IUniswapV2Pair");
            await newSwap.mock.token0.returns(usdc.address);
            await newSwap.mock.token1.returns(btc.address);
            await newSwap.mock.price0CumulativeLast.returns(0);
            await newSwap.mock.price1CumulativeLast.returns(0);
            await newSwap.mock.getReserves.returns(
                SWAP_RESERVE_USDC,
                SWAP_RESERVE_BTC,
                startEpoch - EPOCH
            );
            const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracle");
            const newTwapOracle = await ChainlinkTwapOracle.connect(owner).deploy(
                aggregator.address,
                newSwap.address,
                "BTC"
            );

            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            await newTwapOracle.update(); // First observation
            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await newTwapOracle.update();
            expect(await newTwapOracle.getTwap(startEpoch + EPOCH * 2)).to.equal(START_PRICE);
        });
    });

    describe("updateTwapFromOwner()", async function () {
        beforeEach(async function () {
            // Update an epoch
            await advanceBlockAtTime(startEpoch + EPOCH + 1);
            await twapOracle.update(); // First observation
            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 1);
            await twapOracle.update(); // Update epoch (startEpoch + EPOCH * 2)

            twapOracle = twapOracle.connect(owner);
        });

        it("Should reject data before the epoch is skipped", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE)
            ).to.be.revertedWith("Not ready for owner");
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 20, START_PRICE)
            ).to.be.revertedWith("Not ready for owner");
        });

        it("Should reject data following an uninitialized epoch", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.update(); // Skip an epoch
            await twapOracle.update(); // Skip an epoch
            await twapOracle.update(); // Skip an epoch
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 4, START_PRICE)
            ).to.be.revertedWith("Owner can only update a epoch following an updated epoch");
        });

        it("Should reject data deviating too much", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.update(); // Skip an epoch
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE.mul(20))
            ).to.be.revertedWith("Owner price deviates too much from the last price");
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE.div(20))
            ).to.be.revertedWith("Owner price deviates too much from the last price");
        });

        it("Should reject data if not called by owner", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.update(); // Skip an epoch
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
            await twapOracle.update(); // Skip an epoch
            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 2, START_PRICE)
            ).to.be.revertedWith("Owner cannot update an existing epoch");
        });

        it("Should accept valid data", async function () {
            await advanceBlockAtTime(startEpoch + EPOCH * 10);
            await twapOracle.update(); // Skip an epoch
            await twapOracle.update(); // Skip an epoch
            await twapOracle.update(); // Skip an epoch
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH * 5);

            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 3, START_PRICE.add(10))
            )
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH * 3, START_PRICE.add(10), UPDATE_TYPE_OWNER);
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 3)).to.equal(START_PRICE.add(10));
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH * 5);

            await expect(
                twapOracle.updateTwapFromOwner(startEpoch + EPOCH * 4, START_PRICE.add(20))
            )
                .to.emit(twapOracle, "Update")
                .withArgs(startEpoch + EPOCH * 4, START_PRICE.add(20), UPDATE_TYPE_OWNER);
            expect(await twapOracle.getTwap(startEpoch + EPOCH * 4)).to.equal(START_PRICE.add(20));
            expect(await twapOracle.lastTimestamp()).to.equal(startEpoch + EPOCH * 5);
        });
    });

    describe("peekSwapPrice()", function () {
        it("Should return TWAP since the last observation", async function () {
            await swap.mock.getReserves.returns(
                SWAP_RESERVE_BTC,
                SWAP_RESERVE_USDC,
                startEpoch + EPOCH
            );
            await setNextBlockTime(startEpoch + EPOCH + 60);
            await twapOracle.update(); // First observation

            await advanceBlockAtTime(startEpoch + EPOCH + 100);
            expect(await twapOracle.peekSwapPrice()).to.equal(START_PRICE);
            await advanceBlockAtTime(startEpoch + EPOCH + EPOCH / 2);
            expect(await twapOracle.peekSwapPrice()).to.equal(START_PRICE);

            // The price doubles.
            await swap.mock.getReserves.returns(
                SWAP_RESERVE_BTC,
                SWAP_RESERVE_USDC.mul(2),
                startEpoch + EPOCH + EPOCH / 2 + 60
            );
            await swap.mock.price0CumulativeLast.returns(
                SWAP_RESERVE_USDC.mul(BIT_112)
                    .div(SWAP_RESERVE_BTC)
                    .mul(EPOCH / 2 + 60)
            );
            await swap.mock.price1CumulativeLast.returns(
                SWAP_RESERVE_BTC.mul(BIT_112)
                    .div(SWAP_RESERVE_USDC)
                    .mul(EPOCH / 2 + 60)
            );

            // original price for EPOCH / 2 and doubled price for EPOCH / 2
            await advanceBlockAtTime(startEpoch + EPOCH * 2 + 60);
            expect(await twapOracle.peekSwapPrice()).to.equal(START_PRICE.mul(3).div(2));
            // original price for EPOCH / 2 and doubled price for EPOCH * 1.5
            await advanceBlockAtTime(startEpoch + EPOCH * 3 + 60);
            expect(await twapOracle.peekSwapPrice()).to.equal(START_PRICE.mul(7).div(4));
        });
    });
});
