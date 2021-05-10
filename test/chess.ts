import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";

const DAY = 86400;
const WEEK = DAY * 7;

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

describe("Ballot", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly chess: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let user1: Wallet;
    let user2: Wallet;
    let owner: Wallet;
    let addr1: string;
    let chess: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();

        // Start at the midnight in the next Thursday.
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + WEEK;

        const Chess = await ethers.getContractFactory("Chess");
        const chess = await Chess.connect(owner).deploy(startWeek);

        return {
            wallets: { user1, user2, owner },
            startWeek,
            chess: chess.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        startWeek = fixtureData.startWeek;
        chess = fixtureData.chess;
    });

    describe("getScheduledSupply()", function () {
        it("Should get scheduled supply", async function () {
            expect(await chess.getScheduledSupply(0)).to.equal(BigNumber.from(10).pow(18).mul(100));
            expect(await chess.getScheduledSupply(1)).to.equal(BigNumber.from(10).pow(18).mul(110));
            expect(await chess.getScheduledSupply(2)).to.equal(BigNumber.from(10).pow(18).mul(120));
        });
    });
});
