import { expect } from "chai";
import { BigNumber, Contract, Wallet, BigNumberish } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import {
    DAY,
    WEEK,
    SETTLEMENT_TIME,
    FixtureWalletMap,
    advanceBlockAtTime,
    setNextBlockTime,
} from "./utils";

const MAX_TIME = WEEK * 100;
const MAX_TIME_ALLOWED = WEEK * 50;

function calculateBalanceOf(
    lockAmount: BigNumber,
    unlockTime: number,
    currentTimestamp: number
): BigNumber {
    if (unlockTime <= currentTimestamp) return BigNumber.from("0");
    return lockAmount.mul(unlockTime - currentTimestamp).div(MAX_TIME);
}

function calculateDropBelowTime(
    unlockTime: number,
    threshold: BigNumberish,
    lockAmount: BigNumberish
) {
    return unlockTime - BigNumber.from(MAX_TIME).mul(threshold).div(lockAmount).toNumber();
}

describe("VotingEscrowV2", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly chess: Contract;
        readonly proxyAdmin: Contract;
        readonly votingEscrow: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let startWeek: number;
    let user1: Wallet;
    let user2: Wallet;
    let user3: Wallet;
    let owner: Wallet;
    let addr1: string;
    let addr2: string;
    let addr3: string;
    let chess: Contract;
    let proxyAdmin: Contract;
    let votingEscrow: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner] = provider.getWallets();

        // Start in the middle of a week
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + SETTLEMENT_TIME + WEEK * 10;
        await advanceBlockAtTime(startWeek - WEEK / 2);

        const MockToken = await ethers.getContractFactory("MockToken");
        const chess = await MockToken.connect(owner).deploy("Chess", "Chess", 18);

        const VotingEscrow = await ethers.getContractFactory("VotingEscrowV2");
        const votingEscrowImpl = await VotingEscrow.connect(owner).deploy(chess.address, MAX_TIME);
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const initTx = await votingEscrowImpl.populateTransaction.initialize(
            "Vote-escrowed CHESS",
            "veCHESS",
            MAX_TIME_ALLOWED
        );
        const votingEscrowProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
            votingEscrowImpl.address,
            proxyAdmin.address,
            initTx.data
        );
        const votingEscrow = VotingEscrow.attach(votingEscrowProxy.address);

        await chess.mint(user1.address, parseEther("1000"));
        await chess.mint(user2.address, parseEther("1000"));
        await chess.mint(user3.address, parseEther("1000"));

        await chess.connect(user1).approve(votingEscrow.address, parseEther("1000"));
        await chess.connect(user2).approve(votingEscrow.address, parseEther("1000"));
        await chess.connect(user3).approve(votingEscrow.address, parseEther("1000"));

        return {
            wallets: { user1, user2, user3, owner },
            startWeek,
            chess,
            proxyAdmin,
            votingEscrow: votingEscrow.connect(user1),
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
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        addr2 = user2.address;
        addr3 = user3.address;
        startWeek = fixtureData.startWeek;
        chess = fixtureData.chess;
        proxyAdmin = fixtureData.proxyAdmin;
        votingEscrow = fixtureData.votingEscrow;
    });

    describe("initialize", function () {
        it("Should revert if called again", async function () {
            await expect(votingEscrow.initialize("", "", MAX_TIME)).to.be.revertedWith(
                "Initializable: contract is already initialized"
            );
            await expect(votingEscrow.initializeV2(owner.address, "", "")).to.be.reverted;
        });

        it("Should revert if exceeding max time", async function () {
            // Deploy a new proxied VotingEscrow without initialization
            const impl = await proxyAdmin.getProxyImplementation(votingEscrow.address);
            const TransparentUpgradeableProxy = await ethers.getContractFactory(
                "TransparentUpgradeableProxy"
            );
            const newProxy = await TransparentUpgradeableProxy.connect(owner).deploy(
                impl,
                proxyAdmin.address,
                "0x"
            );
            const newVotingEscrow = await ethers.getContractAt("VotingEscrowV2", newProxy.address);

            await expect(newVotingEscrow.initialize("", "", MAX_TIME + 1)).to.be.revertedWith(
                "Cannot exceed max time"
            );
        });
    });

    describe("updateMaxTimeAllowed()", function () {
        it("Should revert if max time allowed exceeds max time", async function () {
            await expect(
                votingEscrow.connect(owner).updateMaxTimeAllowed(MAX_TIME + 1)
            ).to.revertedWith("Cannot exceed max time");
        });

        it("Should revert if max time allowed decreases", async function () {
            await expect(
                votingEscrow.connect(owner).updateMaxTimeAllowed(MAX_TIME_ALLOWED - WEEK)
            ).to.revertedWith("Cannot shorten max time allowed");
        });

        it("Should revert if not sent from owner", async function () {
            await expect(
                votingEscrow.updateMaxTimeAllowed(MAX_TIME_ALLOWED + WEEK)
            ).to.revertedWith("Ownable: caller is not the owner");
        });

        it("Should update max time allowed", async function () {
            await votingEscrow.connect(owner).updateMaxTimeAllowed(MAX_TIME_ALLOWED + WEEK);
            expect(await votingEscrow.maxTimeAllowed()).to.equal(MAX_TIME_ALLOWED + WEEK);
        });
    });

    describe("createLock()", function () {
        it("Should revert with zero amount", async function () {
            await expect(votingEscrow.createLock(0, startWeek)).to.revertedWith("Zero value");
        });

        it("Should revert with existing lock found", async function () {
            await votingEscrow.createLock(parseEther("10"), startWeek + WEEK);
            await expect(
                votingEscrow.createLock(parseEther("10"), startWeek + WEEK * 2)
            ).to.revertedWith("Withdraw old tokens first");
        });

        it("Should revert with only lock until future time", async function () {
            await expect(
                votingEscrow.createLock(parseEther("10"), startWeek - WEEK)
            ).to.revertedWith("Can only lock until time in the future");
        });

        it("Should revert if locking beyond max time allowed", async function () {
            await expect(
                votingEscrow.createLock(parseEther("10"), startWeek + MAX_TIME_ALLOWED)
            ).to.revertedWith("Voting lock cannot exceed max lock time");
        });

        it("Should revert when called by a smart contract", async function () {
            const someContract = await deployMockForName(owner, "IERC20");
            await expect(
                someContract.call(
                    votingEscrow,
                    "createLock",
                    parseEther("10"),
                    startWeek + WEEK * 10
                )
            ).to.revertedWith("Smart contract depositors not allowed");
        });

        it("Should revert if unlock time is in the middle of a week", async function () {
            await expect(
                votingEscrow.createLock(parseEther("1"), startWeek + WEEK / 2)
            ).to.revertedWith("Unlock time must be end of a week");
        });

        it("Should create lock for user1", async function () {
            const lockAmount = parseEther("10");
            const unlockTime = startWeek + WEEK * 10;
            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(0);
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.be.equal(0);
            expect((await votingEscrow.getLockedBalance(addr1)).unlockTime).to.be.equal(0);
            expect(await votingEscrow.balanceOf(addr1)).to.be.equal(0);
            expect(await votingEscrow.totalSupply()).to.be.equal(0);

            await expect(votingEscrow.createLock(lockAmount, unlockTime))
                .to.emit(votingEscrow, "LockCreated")
                .withArgs(addr1, lockAmount, unlockTime);

            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(
                unlockTime - MAX_TIME
            );
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.be.equal(lockAmount);
            expect((await votingEscrow.getLockedBalance(addr1)).unlockTime).to.be.equal(unlockTime);

            const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
            const balance = calculateBalanceOf(lockAmount, unlockTime, currentTimestamp);
            expect(await votingEscrow.balanceOf(addr1)).to.be.equal(balance);
            expect(await votingEscrow.totalSupply()).to.be.equal(balance);
        });
    });

    describe("increaseAmount()", function () {
        it("Should revert with zero amount", async function () {
            await expect(votingEscrow.increaseAmount(addr1, 0)).to.revertedWith("Zero value");
        });

        it("Should revert with no existing lock found", async function () {
            await expect(votingEscrow.increaseAmount(addr1, parseEther("10"))).to.revertedWith(
                "Cannot add to expired lock"
            );
        });

        it("Should revert with expired lock", async function () {
            await votingEscrow.createLock(parseEther("10"), startWeek + WEEK);
            await advanceBlockAtTime(startWeek + WEEK * 2);
            await expect(votingEscrow.increaseAmount(addr1, parseEther("10"))).to.revertedWith(
                "Cannot add to expired lock"
            );
        });

        it("Should transfer tokens", async function () {
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK * 10);
            await expect(() =>
                votingEscrow.connect(user2).increaseAmount(addr1, parseEther("2"))
            ).to.changeTokenBalances(
                chess,
                [user2, votingEscrow],
                [parseEther("-2"), parseEther("2")]
            );
        });

        it("Should increase amount for self", async function () {
            const lockAmount = parseEther("10");
            const lockAmount2 = parseEther("5");
            const totalLockAmount = lockAmount.add(lockAmount2);
            const unlockTime = startWeek + WEEK * 10;
            await votingEscrow.createLock(lockAmount, unlockTime);
            await advanceBlockAtTime(unlockTime - WEEK);

            await expect(votingEscrow.increaseAmount(addr1, lockAmount2))
                .to.emit(votingEscrow, "AmountIncreased")
                .withArgs(addr1, lockAmount2);

            const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
            const dropTime = calculateDropBelowTime(unlockTime, lockAmount, totalLockAmount);
            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(
                dropTime
            );
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.be.equal(
                totalLockAmount
            );
            expect((await votingEscrow.getLockedBalance(addr1)).unlockTime).to.be.equal(unlockTime);

            const balance = totalLockAmount.mul(unlockTime - currentTimestamp).div(MAX_TIME);
            expect(await votingEscrow.balanceOf(addr1)).to.be.equal(balance);
            expect(await votingEscrow.totalSupply()).to.be.equal(balance);
        });

        it("Should increase amount for other", async function () {
            const lockAmount = parseEther("10");
            const lockAmount2 = parseEther("5");
            const totalLockAmount = lockAmount.add(lockAmount2);
            const unlockTime = startWeek + WEEK * 10;
            await votingEscrow.createLock(lockAmount, unlockTime);
            await advanceBlockAtTime(unlockTime - WEEK);

            await expect(votingEscrow.connect(user2).increaseAmount(addr1, lockAmount2))
                .to.emit(votingEscrow, "AmountIncreased")
                .withArgs(addr1, lockAmount2);

            const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
            const dropTime = calculateDropBelowTime(unlockTime, lockAmount, totalLockAmount);
            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(
                dropTime
            );
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.be.equal(
                totalLockAmount
            );
            expect((await votingEscrow.getLockedBalance(addr1)).unlockTime).to.be.equal(unlockTime);

            const balance = totalLockAmount.mul(unlockTime - currentTimestamp).div(MAX_TIME);
            expect(await votingEscrow.balanceOf(addr1)).to.be.equal(balance);
            expect(await votingEscrow.totalSupply()).to.be.equal(balance);
        });
    });

    describe("increaseUnlockTime()", function () {
        it("Should revert with expired lock", async function () {
            await votingEscrow.createLock(parseEther("10"), startWeek + WEEK);
            await advanceBlockAtTime(startWeek + WEEK * 2);
            await expect(votingEscrow.increaseUnlockTime(startWeek + WEEK * 5)).to.revertedWith(
                "Lock expire"
            );
        });

        it("Should revert with only increase lock duration", async function () {
            await votingEscrow.createLock(parseEther("10"), startWeek + WEEK);
            await expect(votingEscrow.increaseUnlockTime(startWeek + WEEK)).to.revertedWith(
                "Can only increase lock duration"
            );
        });

        it("Should revert with more than max time lock", async function () {
            await votingEscrow.createLock(parseEther("10"), startWeek + WEEK);
            await expect(
                votingEscrow.increaseUnlockTime(startWeek + MAX_TIME_ALLOWED)
            ).to.revertedWith("Voting lock cannot exceed max lock time");
        });

        it("Should revert if unlock time is in the middle of a week", async function () {
            await votingEscrow.createLock(parseEther("10"), startWeek + WEEK);
            await expect(votingEscrow.increaseUnlockTime(startWeek + WEEK * 1.5)).to.revertedWith(
                "Unlock time must be end of a week"
            );
        });

        it("Should increase unlock time for user1", async function () {
            const lockAmount = parseEther("10");
            const unlockTime = startWeek + WEEK * 10;
            const newUnlockTime = unlockTime + WEEK * 2;
            await votingEscrow.createLock(lockAmount, unlockTime);
            await advanceBlockAtTime(unlockTime - WEEK);

            await expect(votingEscrow.increaseUnlockTime(newUnlockTime))
                .to.emit(votingEscrow, "UnlockTimeIncreased")
                .withArgs(addr1, newUnlockTime);

            const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
            const dropTime = calculateDropBelowTime(newUnlockTime, lockAmount.div(2), lockAmount);
            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount.div(2))).to.be.equal(
                dropTime
            );
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.be.equal(lockAmount);
            expect((await votingEscrow.getLockedBalance(addr1)).unlockTime).to.be.equal(
                newUnlockTime
            );

            const balance = lockAmount.mul(newUnlockTime - currentTimestamp).div(MAX_TIME);
            expect(await votingEscrow.balanceOf(addr1)).to.be.equal(balance);
            expect(await votingEscrow.totalSupply()).to.be.equal(balance);
        });
    });

    describe("withdraw()", function () {
        it("Should revert before lock expired", async function () {
            const lockAmount = parseEther("10");
            const unlockTime = startWeek + WEEK * 10;
            await votingEscrow.createLock(lockAmount, unlockTime);
            await expect(votingEscrow.withdraw()).to.revertedWith("The lock is not expired");
        });

        it("Should increase unlock time for user1", async function () {
            const lockAmount = parseEther("10");
            const unlockTime = startWeek + WEEK * 10;
            await votingEscrow.createLock(lockAmount, unlockTime);
            await advanceBlockAtTime(unlockTime);

            await expect(votingEscrow.withdraw())
                .to.emit(votingEscrow, "Withdrawn")
                .withArgs(addr1, lockAmount);

            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(0);
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.be.equal(0);
            expect((await votingEscrow.getLockedBalance(addr1)).unlockTime).to.be.equal(0);
            expect(await votingEscrow.balanceOf(addr1)).to.be.equal(0);
            expect(await votingEscrow.totalSupply()).to.be.equal(0);
        });
    });

    describe("balanceOfAtTimestamp()/totalSupplyAtTimestamp()", function () {
        it("Should reject timestamp in the past", async function () {
            await expect(
                votingEscrow.balanceOfAtTimestamp(addr1, startWeek - WEEK * 10)
            ).to.be.revertedWith("Must be current or future time");
        });

        it("Balance and totalSupply should change with accounts", async function () {
            const lockAmount1 = parseEther("123");
            const lockAmount2 = parseEther("456");
            const lockAmount3 = parseEther("789");
            const startTime = Math.ceil(startWeek / WEEK) * WEEK + SETTLEMENT_TIME;
            const unlockTime1 = startTime + 9 * WEEK;
            const unlockTime2 = startTime + 6 * WEEK;
            const unlockTime3 = startTime + 3 * WEEK;
            await votingEscrow.connect(user1).createLock(lockAmount1, unlockTime1);
            await votingEscrow.connect(user2).createLock(lockAmount2, unlockTime2);
            await votingEscrow.connect(user3).createLock(lockAmount3, unlockTime3);

            for (let i = 0; i < 11; i++) {
                const currentTimestamp = startTime + WEEK * i;
                const balance1 = calculateBalanceOf(lockAmount1, unlockTime1, currentTimestamp);
                const balance2 = calculateBalanceOf(lockAmount2, unlockTime2, currentTimestamp);
                const balance3 = calculateBalanceOf(lockAmount3, unlockTime3, currentTimestamp);
                const totalSupply = balance1.add(balance2).add(balance3);

                expect(
                    await votingEscrow.balanceOfAtTimestamp(addr1, currentTimestamp)
                ).to.be.equal(balance1);
                expect(
                    await votingEscrow.balanceOfAtTimestamp(addr2, currentTimestamp)
                ).to.be.equal(balance2);
                expect(
                    await votingEscrow.balanceOfAtTimestamp(addr3, currentTimestamp)
                ).to.be.equal(balance3);
                expect(await votingEscrow.totalSupplyAtTimestamp(currentTimestamp)).to.be.equal(
                    totalSupply
                );
            }
        });
    });

    describe("getTimestampDropBelow()", function () {
        let lockAmount: BigNumber;
        let threshold: BigNumber;
        let unlockTime: number;
        let dropTimeBefore: number;

        beforeEach(async function () {
            lockAmount = parseEther("10");
            threshold = lockAmount.div(3);
            unlockTime = startWeek + WEEK * 10;
            dropTimeBefore = calculateDropBelowTime(unlockTime, threshold, lockAmount);

            await votingEscrow.createLock(lockAmount, unlockTime);
        });

        it("Should return zero if non existing lock", async function () {
            expect(await votingEscrow.getTimestampDropBelow(addr2, 0)).to.be.equal(0);
        });

        it("Should return end time if lock exists", async function () {
            const dropTime = calculateDropBelowTime(unlockTime, 0, lockAmount);
            expect(await votingEscrow.getTimestampDropBelow(addr1, 0)).to.be.equal(dropTime);
        });

        it("Should return zero if lock amount is below threshold", async function () {
            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount.add(1))).to.be.equal(
                0
            );
        });

        it("Should return start week if lock amount is equal to threshold", async function () {
            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(
                unlockTime - MAX_TIME
            );
        });

        it("Should increase as threshold decrease", async function () {
            const lowerThreshold = lockAmount.div(4);
            const higherThreshold = lockAmount.div(2);
            const lowerThresholdDropTime = calculateDropBelowTime(
                unlockTime,
                lowerThreshold,
                lockAmount
            );
            const higherThresholdDropTime = calculateDropBelowTime(
                unlockTime,
                higherThreshold,
                lockAmount
            );

            expect(await votingEscrow.getTimestampDropBelow(addr1, lowerThreshold)).to.be.equal(
                lowerThresholdDropTime
            );
            expect(await votingEscrow.getTimestampDropBelow(addr1, higherThreshold)).to.be.equal(
                higherThresholdDropTime
            );
            expect(dropTimeBefore).to.be.lessThan(lowerThresholdDropTime);
            expect(dropTimeBefore).to.be.greaterThan(higherThresholdDropTime);
        });

        it("Drop below time should increase after increaseAmount", async function () {
            const lockAmount2 = parseEther("5");
            const totalLockAmount = lockAmount.add(lockAmount2);
            const dropTimeAfterDepositFor = calculateDropBelowTime(
                unlockTime,
                threshold,
                totalLockAmount
            );

            await votingEscrow.increaseAmount(addr1, lockAmount2);
            expect(await votingEscrow.getTimestampDropBelow(addr1, threshold)).to.be.equal(
                dropTimeAfterDepositFor
            );

            expect(dropTimeBefore).to.be.lessThan(dropTimeAfterDepositFor);
        });

        it("Drop below time should increase after increaseUnlockTime", async function () {
            const newUnlockTime = unlockTime + WEEK * 2;
            const dropTimeAfterDepositFor = calculateDropBelowTime(
                newUnlockTime,
                threshold,
                lockAmount
            );

            await votingEscrow.increaseUnlockTime(newUnlockTime);
            expect(await votingEscrow.getTimestampDropBelow(addr1, threshold)).to.be.equal(
                dropTimeAfterDepositFor
            );

            expect(dropTimeBefore).to.be.lessThan(dropTimeAfterDepositFor);
        });
    });

    describe("Incremental supply calculation", function () {
        it("Should calculate current total supply", async function () {
            const amount1 = parseEther("1");
            const amount2 = parseEther("3");
            await votingEscrow.createLock(amount1, startWeek + WEEK * 2);
            await votingEscrow.connect(user2).createLock(amount2, startWeek + WEEK * 5);

            const balance1 = amount1.mul(WEEK * 2 - DAY * 4).div(MAX_TIME);
            const balance2 = amount2.mul(WEEK * 5 - DAY * 4).div(MAX_TIME);
            const supply = balance1.add(balance2);
            await advanceBlockAtTime(startWeek + DAY * 4);
            expect(await votingEscrow.totalSupply()).to.closeTo(supply, 30);
        });

        it("Should calculate current total supply when someone will unlock soon", async function () {
            const amount1 = parseEther("1");
            const amount2 = parseEther("3");
            await votingEscrow.createLock(amount1, startWeek + WEEK * 2);
            await votingEscrow.connect(user2).createLock(amount2, startWeek + WEEK * 5);

            const balance1 = amount1.mul(WEEK * 2 - DAY * 10).div(MAX_TIME);
            const balance2 = amount2.mul(WEEK * 5 - DAY * 10).div(MAX_TIME);
            const supply = balance1.add(balance2);
            await advanceBlockAtTime(startWeek + DAY * 10);
            expect(await votingEscrow.totalSupply()).to.closeTo(supply, 30);
        });

        it("Should calculate current total supply after someone unlocks", async function () {
            const amount1 = parseEther("1");
            const amount2 = parseEther("3");
            await votingEscrow.createLock(amount1, startWeek + WEEK * 2);
            await votingEscrow.connect(user2).createLock(amount2, startWeek + WEEK * 5);

            const balance2 = amount2.mul(DAY * 4).div(MAX_TIME);
            await advanceBlockAtTime(startWeek + WEEK * 4 + DAY * 3);
            expect(await votingEscrow.totalSupply()).to.closeTo(balance2, 30);
        });

        it("Should calculate current total supply after increaseAmount()", async function () {
            const amount1 = parseEther("1");
            const amount2 = parseEther("3");
            await votingEscrow.createLock(amount1, startWeek + WEEK * 2);
            await votingEscrow.connect(user2).createLock(amount2, startWeek + WEEK * 5);

            await setNextBlockTime(startWeek + DAY * 10);
            await votingEscrow.increaseAmount(addr1, amount1);
            const balance1 = amount1
                .mul(2)
                .mul(WEEK * 2 - DAY * 10)
                .div(MAX_TIME);
            const balance2 = amount2.mul(WEEK * 5 - DAY * 10).div(MAX_TIME);
            const supply = balance1.add(balance2);
            expect(await votingEscrow.totalSupply()).to.closeTo(supply, 30);

            const newBalance2 = amount2.mul(DAY * 4).div(MAX_TIME);
            await advanceBlockAtTime(startWeek + WEEK * 4 + DAY * 3);
            expect(await votingEscrow.totalSupply()).to.closeTo(newBalance2, 30);

            await advanceBlockAtTime(startWeek + WEEK * 6);
            expect(await votingEscrow.totalSupply()).to.closeTo(BigNumber.from(0), 30);
        });

        it("Should calculate current total supply after increaseUnlockTime()", async function () {
            const amount1 = parseEther("1");
            const amount2 = parseEther("3");
            await votingEscrow.createLock(amount1, startWeek + WEEK * 2);
            await votingEscrow.connect(user2).createLock(amount2, startWeek + WEEK * 5);

            await setNextBlockTime(startWeek + DAY * 10);
            await votingEscrow.increaseUnlockTime(startWeek + WEEK * 4);
            const balance1 = amount1.mul(WEEK * 4 - DAY * 10).div(MAX_TIME);
            const balance2 = amount2.mul(WEEK * 5 - DAY * 10).div(MAX_TIME);
            const supply = balance1.add(balance2);
            expect(await votingEscrow.totalSupply()).to.closeTo(supply, 30);

            const newBalance2 = amount2.mul(DAY * 4).div(MAX_TIME);
            await advanceBlockAtTime(startWeek + WEEK * 4 + DAY * 3);
            expect(await votingEscrow.totalSupply()).to.closeTo(newBalance2, 30);

            await advanceBlockAtTime(startWeek + WEEK * 6);
            expect(await votingEscrow.totalSupply()).to.closeTo(BigNumber.from(0), 30);
        });

        it("Should calculate historical supply for one week", async function () {
            const amount1 = parseEther("1");
            const amount2 = parseEther("3");
            await votingEscrow.createLock(amount1, startWeek + WEEK * 2);
            await votingEscrow.connect(user2).createLock(amount2, startWeek + WEEK * 5);
            expect(await votingEscrow.veSupplyPerWeek(startWeek)).to.equal(0);

            const balance1 = amount1.mul(WEEK * 2).div(MAX_TIME);
            const balance2 = amount2.mul(WEEK * 5).div(MAX_TIME);
            const supply = balance1.add(balance2);
            await advanceBlockAtTime(startWeek + DAY);
            await votingEscrow.increaseAmount(addr1, 1); // Trigger checkpoint
            expect(await votingEscrow.veSupplyPerWeek(startWeek)).to.closeTo(supply, 30);

            // The calculated supply in the past does not change any more
            await advanceBlockAtTime(startWeek + DAY * 10);
            expect(await votingEscrow.veSupplyPerWeek(startWeek)).to.closeTo(supply, 30);
            await votingEscrow.increaseUnlockTime(startWeek + WEEK * 10);
            expect(await votingEscrow.veSupplyPerWeek(startWeek)).to.closeTo(supply, 30);
        });

        it("Should calculate historical supply for multiple weeks", async function () {
            const amount1 = parseEther("1");
            const amount2 = parseEther("5");
            const amount3 = parseEther("11");
            await votingEscrow.createLock(amount1, startWeek + WEEK);
            await votingEscrow.connect(user2).createLock(amount2, startWeek + WEEK * 2);
            await votingEscrow.connect(user3).createLock(amount3, startWeek + WEEK * 8);
            await advanceBlockAtTime(startWeek + WEEK * 3 - 100);
            await votingEscrow.increaseAmount(addr3, 1); // Trigger checkpoint

            const w0 = startWeek;
            const balance1w0 = amount1.mul(WEEK).div(MAX_TIME);
            const balance2w0 = amount2.mul(WEEK * 2).div(MAX_TIME);
            const balance3w0 = amount3.mul(WEEK * 8).div(MAX_TIME);
            const supply0 = balance1w0.add(balance2w0).add(balance3w0);
            expect(await votingEscrow.veSupplyPerWeek(w0)).to.closeTo(supply0, 30);

            const w1 = startWeek + WEEK;
            const balance2w1 = amount2.mul(WEEK).div(MAX_TIME);
            const balance3w1 = amount3.mul(WEEK * 7).div(MAX_TIME);
            const supply1 = balance2w1.add(balance3w1);
            expect(await votingEscrow.veSupplyPerWeek(w1)).to.closeTo(supply1, 30);

            const w2 = startWeek + WEEK * 2;
            const supply2 = amount3.mul(WEEK * 6).div(MAX_TIME);
            expect(await votingEscrow.veSupplyPerWeek(w2)).to.closeTo(supply2, 30);
        });

        it("Reproduce rounding errors", async function () {
            await votingEscrow.createLock(1, startWeek + WEEK * 10);
            // Both account balance and total supply are rounded down when computed from scratch.
            expect(await votingEscrow.balanceOfAtTimestamp(addr1, startWeek)).to.equal(0);
            expect(await votingEscrow.totalSupplyAtTimestamp(startWeek)).to.equal(0);
            // Incremental updated total supply is rounded up.
            expect(await votingEscrow.nextWeekSupply()).to.equal(1);
            expect(await votingEscrow.totalSupply()).to.equal(1);

            // The rounding error is accumulated.
            await votingEscrow.connect(user2).createLock(1, startWeek + WEEK * 10);
            expect(await votingEscrow.totalSupplyAtTimestamp(startWeek)).to.equal(0);
            expect(await votingEscrow.totalLocked()).to.equal(2);
            expect(await votingEscrow.nextWeekSupply()).to.equal(2);
            expect(await votingEscrow.totalSupply()).to.equal(2);

            // The rounding error persists over weeks.
            await advanceBlockAtTime(startWeek + WEEK * 5);
            await votingEscrow.connect(user3).createLock(1, startWeek + WEEK * 10);
            expect(await votingEscrow.totalSupplyAtTimestamp(startWeek + WEEK * 6)).to.equal(0);
            expect(await votingEscrow.totalLocked()).to.equal(3);
            expect(await votingEscrow.nextWeekSupply()).to.equal(3);
            expect(await votingEscrow.totalSupply()).to.equal(3);

            // The rounding error persists even after all Chess unlocked.
            await advanceBlockAtTime(startWeek + WEEK * 20);
            await votingEscrow.withdraw();
            await votingEscrow.createLock(1, startWeek + WEEK * 30);
            expect(await votingEscrow.totalSupplyAtTimestamp(startWeek + WEEK * 21)).to.equal(0);
            expect(await votingEscrow.totalLocked()).to.equal(1);
            expect(await votingEscrow.nextWeekSupply()).to.equal(4);
            expect(await votingEscrow.totalSupply()).to.equal(4);
        });

        it("Should fix rounding errors in the same week", async function () {
            await votingEscrow.createLock(1, startWeek + WEEK * 10);
            await votingEscrow.connect(user2).createLock(1, startWeek + WEEK * 10);
            await votingEscrow.connect(user3).createLock(1, startWeek + WEEK * 10);
            expect(await votingEscrow.nextWeekSupply()).to.equal(3);
            expect(await votingEscrow.totalSupply()).to.equal(3);
            await votingEscrow.calibrateSupply();
            expect(await votingEscrow.nextWeekSupply()).to.equal(0);
            expect(await votingEscrow.totalSupply()).to.equal(0);
        });

        it("Should fix rounding errors after some weeks", async function () {
            await votingEscrow.createLock(1, startWeek + WEEK * 10);
            await votingEscrow.connect(user2).createLock(1, startWeek + WEEK * 30);
            await votingEscrow.connect(user3).createLock(1, startWeek + WEEK * 30);
            await advanceBlockAtTime(startWeek + WEEK * 15);
            expect(await votingEscrow.nextWeekSupply()).to.equal(3);
            expect(await votingEscrow.totalSupply()).to.equal(3);
            await votingEscrow.calibrateSupply();
            expect(await votingEscrow.nextWeekSupply()).to.equal(0);
            expect(await votingEscrow.totalSupply()).to.equal(0);

            // The rounding error is accumulated again.
            await votingEscrow.withdraw();
            await votingEscrow.createLock(1, startWeek + WEEK * 30);
            expect(await votingEscrow.nextWeekSupply()).to.equal(1);
            expect(await votingEscrow.totalSupply()).to.equal(1);
        });
    });

    describe("updateAddressWhitelist()", function () {
        let newWhitelist: MockContract;
        let someContract: MockContract;

        beforeEach(async function () {
            newWhitelist = await deployMockForName(
                owner,
                "contracts/governance/VotingEscrowV2.sol:IAddressWhitelist"
            );
            someContract = await deployMockForName(owner, "IERC20");
            await chess.mint(someContract.address, parseEther("1000"));
            await someContract.call(chess, "approve", votingEscrow.address, parseEther("1000"));
        });

        it("Should only be called by owner", async function () {
            await expect(
                votingEscrow.updateAddressWhitelist(newWhitelist.address)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject non-contract whitelist address", async function () {
            await expect(
                votingEscrow.connect(owner).updateAddressWhitelist(addr1)
            ).to.be.revertedWith("Must be null or a contract");
        });

        it("Should reject non-whitelisted contract to create lock", async function () {
            await newWhitelist.mock.check.withArgs(someContract.address).returns(false);
            await votingEscrow.connect(owner).updateAddressWhitelist(newWhitelist.address);
            await expect(
                someContract.call(
                    votingEscrow,
                    "createLock",
                    parseEther("10"),
                    startWeek + WEEK * 10
                )
            ).to.revertedWith("Smart contract depositors not allowed");
        });

        it("Should allow whitelisted contract to create lock", async function () {
            await votingEscrow.connect(owner).updateAddressWhitelist(newWhitelist.address);
            await expect(() =>
                someContract.call(
                    votingEscrow,
                    "createLock",
                    parseEther("10"),
                    startWeek + WEEK * 10
                )
            ).to.callMocks({
                func: newWhitelist.mock.check.withArgs(someContract.address),
                rets: [true],
            });
        });
    });

    describe("updateCallback()", function () {
        let callback: MockContract;

        beforeEach(async function () {
            callback = await deployMockForName(owner, "IVotingEscrowCallback");
        });

        it("Should only be called by owner", async function () {
            await expect(votingEscrow.updateCallback(callback.address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should reject non-contract callback address", async function () {
            await expect(votingEscrow.connect(owner).updateCallback(addr1)).to.be.revertedWith(
                "Must be null or a contract"
            );
        });

        it("Should invoke callback in createLock()", async function () {
            await votingEscrow.connect(owner).updateCallback(callback.address);
            await expect(() =>
                votingEscrow.createLock(parseEther("1"), startWeek + WEEK)
            ).to.callMocks({
                func: callback.mock.syncWithVotingEscrow.withArgs(addr1),
            });
        });

        it("Should invoke callback in increaseAmount()", async function () {
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK);
            await votingEscrow.connect(owner).updateCallback(callback.address);
            await expect(() => votingEscrow.increaseAmount(addr1, 1)).to.callMocks({
                func: callback.mock.syncWithVotingEscrow.withArgs(addr1),
            });
        });

        it("Should invoke callback in increaseUnlockTime()", async function () {
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK);
            await votingEscrow.connect(owner).updateCallback(callback.address);
            await expect(() => votingEscrow.increaseUnlockTime(startWeek + WEEK * 2)).to.callMocks({
                func: callback.mock.syncWithVotingEscrow.withArgs(addr1),
            });
        });

        it("Should not invoke callback after it is cleared", async function () {
            await votingEscrow.connect(owner).updateCallback(callback.address);
            await callback.mock.syncWithVotingEscrow.withArgs(addr1).returns();
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK);
            await callback.mock.syncWithVotingEscrow
                .withArgs(addr1)
                .revertsWithReason("Mock on the method is not initialized");
            await votingEscrow.connect(owner).updateCallback(ethers.constants.AddressZero);
            await votingEscrow.increaseAmount(addr1, 1);
        });
    });

    describe("pause() and unpause()", function () {
        it("Should pause createLock()", async function () {
            await votingEscrow.connect(owner).pause();
            await expect(
                votingEscrow.createLock(parseEther("1"), startWeek + WEEK)
            ).to.be.revertedWith("Pausable: paused");
            await votingEscrow.connect(owner).unpause();
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK);
        });

        it("Should pause increaseAmount()", async function () {
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK);
            await votingEscrow.connect(owner).pause();
            await expect(votingEscrow.increaseAmount(addr1, 1)).to.be.revertedWith(
                "Pausable: paused"
            );
            await votingEscrow.connect(owner).unpause();
            await votingEscrow.increaseAmount(addr1, 1);
        });

        it("Should pause increaseUnlockTime()", async function () {
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK);
            await votingEscrow.connect(owner).pause();
            await expect(votingEscrow.increaseUnlockTime(startWeek + WEEK * 2)).to.be.revertedWith(
                "Pausable: paused"
            );
            await votingEscrow.connect(owner).unpause();
            await votingEscrow.increaseUnlockTime(startWeek + WEEK * 2);
        });

        it("Should not pause withdraw()", async function () {
            await votingEscrow.createLock(parseEther("1"), startWeek + WEEK);
            await advanceBlockAtTime(startWeek + WEEK);
            await votingEscrow.connect(owner).pause();
            await votingEscrow.withdraw();
            await votingEscrow.connect(owner).unpause();
            await votingEscrow.withdraw();
        });
    });
});
