import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { FixtureWalletMap, advanceBlockAtTime } from "./utils";
import { deployMockForName } from "./mock";
import { parseEther, parseUnits } from "@ethersproject/units";
import { BigNumber } from "@ethersproject/bignumber";

const EPOCH = 1800; // 30 min
const PUBLISHING_DELAY = 120; // 2 min
const CHAINLINK_DECIMAL = 8;

describe("ChainlinkTwapOracle", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly aggregator: MockContract;
        readonly swap: MockContract;
        readonly twapOracle: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let aggregator: MockContract;
    let swap: MockContract;
    let twapOracle: Contract;

    const currentID = 42;
    const currentPrice0CumulativeT0 = BigNumber.from("228153871716166680761678287507817896287");
    const currentPrice1CumulativeT0 = BigNumber.from("100000000000000000000000000000000000000000");
    const reserve0T0 = parseEther("600");
    const reserve1T0 = parseEther("20");
    const reserve0T30 = parseEther("700");
    const reserve1T30 = parseEther("13");
    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, owner] = provider.getWallets();

        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.floor(startTimestamp / EPOCH) * EPOCH;

        const aggregator = await deployMockForName(owner, "IAggregatorProxy");
        const swap = await deployMockForName(owner, "IUniswapV2Pair");

        await aggregator.mock.decimals.returns(CHAINLINK_DECIMAL);
        await aggregator.mock.phaseId.returns(2);
        await aggregator.mock.latestRoundData.returns(currentID, 0, 0, startWeek - 1, 0);
        await swap.mock.price0CumulativeLast.returns(currentPrice0CumulativeT0);
        await swap.mock.price1CumulativeLast.returns(currentPrice1CumulativeT0);
        await swap.mock.getReserves.returns(reserve0T0, reserve1T0, startWeek);
        const ChainlinkTwapOracle = await ethers.getContractFactory("ChainlinkTwapOracle");
        const twapOracle = await ChainlinkTwapOracle.connect(owner).deploy(
            aggregator.address,
            swap.address,
            "Mock BTC"
        );

        return {
            wallets: { user1, owner },
            startWeek,
            aggregator,
            swap,
            twapOracle,
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        startWeek = fixtureData.startWeek;
        aggregator = fixtureData.aggregator;
        swap = fixtureData.swap;
        twapOracle = fixtureData.twapOracle;
    });

    describe("getTwap()", function () {
        beforeEach(async function () {
            for (let index = 0; index < 70; index++) {
                await aggregator.mock.getRoundData
                    .withArgs(currentID + index)
                    .returns(
                        0,
                        parseUnits("1", CHAINLINK_DECIMAL).mul(index),
                        0,
                        startWeek - EPOCH + index * 60,
                        0
                    );
            }
        });

        it("Should get Chainlink oracle without update", async function () {
            await advanceBlockAtTime(startWeek + EPOCH + PUBLISHING_DELAY);
            await aggregator.mock.latestRoundData.returns(102, 0, 0, startWeek + EPOCH, 0);
            expect(await twapOracle.currentRoundID()).to.equal(42);
            expect(await twapOracle.currentTimestamp()).to.equal(startWeek);
            expect(await twapOracle.getTwap(startWeek + EPOCH)).to.equal(
                parseEther("30").add(parseEther("59")).div(2)
            );
        });
    });

    describe("updateTwapFromChainlink()", function () {
        beforeEach(async function () {
            await aggregator.mock.getRoundData
                .withArgs(currentID - 1)
                .returns(0, 0, 0, startWeek - EPOCH - 60, 0);
            for (let index = 0; index < 70; index++) {
                await aggregator.mock.getRoundData
                    .withArgs(currentID + index)
                    .returns(
                        0,
                        parseUnits("1", CHAINLINK_DECIMAL).mul(index),
                        0,
                        startWeek - EPOCH + index * 60,
                        0
                    );
            }
        });

        it("Should get Chainlink oracle with update", async function () {
            await advanceBlockAtTime(startWeek + EPOCH + PUBLISHING_DELAY);
            await aggregator.mock.latestRoundData.returns(102, 0, 0, startWeek + EPOCH, 0);
            await twapOracle.updateTwapFromChainlink();
            expect(await twapOracle.currentRoundID()).to.equal(72);
            expect(await twapOracle.currentTimestamp()).to.equal(startWeek + EPOCH);
            expect(await twapOracle.getTwap(startWeek)).to.equal(
                parseEther("0").add(parseEther("29")).div(2)
            );

            expect(await twapOracle.getTwap(startWeek + EPOCH)).to.equal(
                parseEther("30").add(parseEther("59")).div(2)
            );
            await twapOracle.updateTwapFromChainlink();
            expect(await twapOracle.currentRoundID()).to.equal(102);
            expect(await twapOracle.currentTimestamp()).to.equal(startWeek + EPOCH * 2);
            expect(await twapOracle.getTwap(startWeek + EPOCH)).to.equal(
                parseEther("30").add(parseEther("59")).div(2)
            );
        });
    });

    describe("updateTwapFromSwap()", function () {
        beforeEach(async function () {
            for (let index = 0; index < 70; index++) {
                await aggregator.mock.getRoundData
                    .withArgs(currentID + index)
                    .returns(
                        0,
                        parseUnits("1", CHAINLINK_DECIMAL).mul(index),
                        0,
                        startWeek - EPOCH + index * 60,
                        0
                    );
            }
            await twapOracle.update();
        });

        it("Should revert if not yet ready for swap", async function () {
            await advanceBlockAtTime(startWeek + EPOCH + PUBLISHING_DELAY);
            await expect(twapOracle.updateTwapFromSwap()).to.be.revertedWith("Not yet for swap");
        });

        it("Should get Swap oracle if no update on the swap pair", async function () {
            await advanceBlockAtTime(startWeek + EPOCH * 2 - 5);
            await twapOracle.updateCumulativeFromSwap();
            await advanceBlockAtTime(startWeek + EPOCH * 2 + PUBLISHING_DELAY);
            console.log(
                (await twapOracle.observations(startWeek + EPOCH)).toString(),
                (await twapOracle.observations(startWeek + EPOCH * 2)).toString()
            );
            expect(await twapOracle.getTwap(startWeek + EPOCH * 2)).to.equal(
                reserve0T0.mul(parseEther("1")).div(reserve1T0)
            );
        });

        it("Should get Swap oracle if one update on the swap pair", async function () {
            const swapUpdateTimestamp = EPOCH + EPOCH / 3;
            await swap.mock.price1CumulativeLast.returns(
                currentPrice1CumulativeT0.add(
                    reserve0T0.shl(112).div(reserve1T0).mul(swapUpdateTimestamp)
                )
            );
            await swap.mock.getReserves.returns(
                reserve0T30,
                reserve1T30,
                startWeek + swapUpdateTimestamp
            );
            await advanceBlockAtTime(startWeek + EPOCH * 2 - 5);
            await twapOracle.updateCumulativeFromSwap();
            await advanceBlockAtTime(startWeek + EPOCH * 2 + PUBLISHING_DELAY);
            const startObservation = await twapOracle.observations(startWeek + EPOCH);
            const endObservation = await twapOracle.observations(startWeek + EPOCH * 2);
            console.log(startObservation.toString(), endObservation.toString());
            expect(await twapOracle.getTwap(startWeek + EPOCH * 2)).to.equal(
                reserve0T0
                    .mul(parseEther("1"))
                    .mul(
                        BigNumber.from(startWeek + swapUpdateTimestamp).sub(
                            startObservation.timestamp
                        )
                    )
                    .div(reserve1T0)
                    .add(
                        reserve0T30
                            .mul(parseEther("1"))
                            .mul(
                                endObservation.timestamp.sub(
                                    BigNumber.from(startWeek + swapUpdateTimestamp)
                                )
                            )
                            .div(reserve1T30)
                    )
                    .div(endObservation.timestamp.sub(startObservation.timestamp))
            );
        });
    });

    describe("nearestRoundID()", function () {
        it("Should search for the greatest updatedAt smaller than endTimestamp", async function () {
            await aggregator.mock.getRoundData.withArgs(currentID).returns(0, 0, 0, 2, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 1).returns(0, 0, 0, 3, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 2).returns(0, 0, 0, 5, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 3).returns(0, 0, 0, 7, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 4).returns(0, 0, 0, 11, 0);
            await aggregator.mock.getRoundData.withArgs(currentID + 5).returns(0, 0, 0, 13, 0);
            expect(await twapOracle.nearestRoundID(currentID + 5, 1)).to.equal(currentID - 1);
            expect(await twapOracle.nearestRoundID(currentID + 5, 2)).to.equal(currentID - 1);
            expect(await twapOracle.nearestRoundID(currentID + 5, 3)).to.equal(currentID);
            expect(await twapOracle.nearestRoundID(currentID + 5, 4)).to.equal(currentID + 1);
            expect(await twapOracle.nearestRoundID(currentID + 5, 5)).to.equal(currentID + 1);
            expect(await twapOracle.nearestRoundID(currentID + 5, 6)).to.equal(currentID + 2);
            expect(await twapOracle.nearestRoundID(currentID + 5, 7)).to.equal(currentID + 2);
            expect(await twapOracle.nearestRoundID(currentID + 5, 8)).to.equal(currentID + 3);
            expect(await twapOracle.nearestRoundID(currentID + 5, 9)).to.equal(currentID + 3);
            expect(await twapOracle.nearestRoundID(currentID + 5, 10)).to.equal(currentID + 3);
            expect(await twapOracle.nearestRoundID(currentID + 5, 11)).to.equal(currentID + 3);
            expect(await twapOracle.nearestRoundID(currentID + 5, 12)).to.equal(currentID + 4);
            expect(await twapOracle.nearestRoundID(currentID + 5, 13)).to.equal(currentID + 4);
            expect(await twapOracle.nearestRoundID(currentID + 5, 14)).to.equal(currentID + 5);
        });
    });
});
