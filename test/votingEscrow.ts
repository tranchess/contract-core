import { expect } from "chai";
import { BigNumber, Contract, Wallet, constants, BigNumberish } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther } = ethers.utils;
import { deployMockForName } from "./mock";
import { DAY, WEEK, SETTLEMENT_TIME, FixtureWalletMap, advanceBlockAtTime } from "./utils";

const MAX_TIME = BigNumber.from(WEEK * 100);
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
    return BigNumber.from(unlockTime).sub(MAX_TIME.mul(threshold).div(lockAmount));
}

describe("VotingEscrow", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly startWeek: number;
        readonly chess: Contract;
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
    let votingEscrow: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner] = provider.getWallets();

        // Start in the middle of a week
        const startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        const startWeek = Math.ceil(startTimestamp / WEEK) * WEEK + SETTLEMENT_TIME + WEEK * 10;
        advanceBlockAtTime(startWeek - WEEK / 2);

        const MockToken = await ethers.getContractFactory("MockToken");
        const chess = await MockToken.connect(owner).deploy("Chess", "Chess", 18);

        const VotingEscrow = await ethers.getContractFactory("VotingEscrow");
        const votingEscrowImpl = await VotingEscrow.connect(owner).deploy(
            chess.address,
            constants.AddressZero,
            "veChess",
            "veChess",
            MAX_TIME
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.connect(owner).deploy();
        const initTx = await votingEscrowImpl.populateTransaction.initialize(MAX_TIME_ALLOWED);
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
        votingEscrow = fixtureData.votingEscrow;
    });

    describe("updateMaxTimeAllowed", function () {
        it("Should revert if max time allowed exceeds max time", async function () {
            await expect(
                votingEscrow.connect(owner).updateMaxTimeAllowed(MAX_TIME.add(1))
            ).to.revertedWith("Cannot exceed max time");
        });

        it("Should revert if max time allowed decreases", async function () {
            await expect(
                votingEscrow.connect(owner).updateMaxTimeAllowed(MAX_TIME_ALLOWED - WEEK)
            ).to.revertedWith("Cannot shorten max time allowed");
        });

        it("Should revert if creating a lock exceeding max time allowed", async function () {
            await expect(
                votingEscrow.createLock(
                    parseEther("10"),
                    startWeek + MAX_TIME_ALLOWED,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Voting lock cannot exceed max lock time");
        });

        it("Should revert if increasing unlock time exceeding max time allowed", async function () {
            await votingEscrow.createLock(parseEther("10"), startWeek);
            await expect(
                votingEscrow.increaseUnlockTime(
                    startWeek + MAX_TIME_ALLOWED,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Voting lock cannot exceed max lock time");
        });
    });

    describe("createLock()", function () {
        it("Should revert with zero amount", async function () {
            await expect(
                votingEscrow.createLock(0, startWeek, constants.AddressZero, constants.HashZero)
            ).to.revertedWith("Zero value");
        });

        it("Should revert with existing lock found", async function () {
            await votingEscrow.createLock(
                parseEther("10"),
                startWeek + WEEK,
                constants.AddressZero,
                constants.HashZero
            );
            await expect(
                votingEscrow.createLock(
                    parseEther("10"),
                    startWeek + WEEK * 2,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Withdraw old tokens first");
        });

        it("Should revert with only lock until future time", async function () {
            await expect(
                votingEscrow.createLock(
                    parseEther("10"),
                    startWeek - 1,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Can only lock until time in the future");
        });

        it("Should revert with more than max time lock", async function () {
            await expect(
                votingEscrow.createLock(
                    parseEther("10"),
                    startWeek + 365 * 5 * DAY,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Voting lock cannot exceed max lock time");
        });

        it("Should revert when called by a smart contract", async function () {
            const someContract = await deployMockForName(owner, "IERC20");
            await expect(
                someContract.call(
                    votingEscrow,
                    "createLock",
                    parseEther("10"),
                    startWeek + WEEK * 10,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Smart contract depositors not allowed");
        });

        it("Should create lock for user1", async function () {
            const lockAmount = parseEther("10");
            const unlockTime = startWeek + WEEK * 10;
            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(0);
            expect((await votingEscrow.getLockedBalance(addr1)).amount).to.be.equal(0);
            expect((await votingEscrow.getLockedBalance(addr1)).unlockTime).to.be.equal(0);
            expect(await votingEscrow.balanceOf(addr1)).to.be.equal(0);
            expect(await votingEscrow.totalSupply()).to.be.equal(0);

            await expect(
                votingEscrow.createLock(
                    lockAmount,
                    unlockTime,
                    constants.AddressZero,
                    constants.HashZero
                )
            )
                .to.emit(votingEscrow, "LockCreated")
                .withArgs(addr1, lockAmount, unlockTime);

            expect(await votingEscrow.getTimestampDropBelow(addr1, lockAmount)).to.be.equal(
                unlockTime - MAX_TIME.toNumber()
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
            await expect(
                votingEscrow.increaseAmount(addr1, 0, constants.AddressZero, constants.HashZero)
            ).to.revertedWith("Zero value");
        });

        it("Should revert with no existing lock found", async function () {
            await expect(
                votingEscrow.increaseAmount(
                    addr1,
                    parseEther("10"),
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Cannot add to expired lock");
        });

        it("Should revert with expired lock", async function () {
            await votingEscrow.createLock(
                parseEther("10"),
                startWeek + WEEK,
                constants.AddressZero,
                constants.HashZero
            );
            advanceBlockAtTime(startWeek + WEEK * 2);
            await expect(
                votingEscrow.increaseAmount(
                    addr1,
                    parseEther("10"),
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Cannot add to expired lock");
        });

        it("Should transfer tokens", async function () {
            await votingEscrow.createLock(
                parseEther("1"),
                startWeek + WEEK * 10,
                constants.AddressZero,
                constants.HashZero
            );
            await expect(() =>
                votingEscrow
                    .connect(user2)
                    .increaseAmount(
                        addr1,
                        parseEther("2"),
                        constants.AddressZero,
                        constants.HashZero
                    )
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
            await votingEscrow.createLock(
                lockAmount,
                unlockTime,
                constants.AddressZero,
                constants.HashZero
            );
            advanceBlockAtTime(unlockTime - WEEK);

            await expect(
                votingEscrow.increaseAmount(
                    addr1,
                    lockAmount2,
                    constants.AddressZero,
                    constants.HashZero
                )
            )
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
            await votingEscrow.createLock(
                lockAmount,
                unlockTime,
                constants.AddressZero,
                constants.HashZero
            );
            advanceBlockAtTime(unlockTime - WEEK);

            await expect(
                votingEscrow
                    .connect(user2)
                    .increaseAmount(addr1, lockAmount2, constants.AddressZero, constants.HashZero)
            )
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
            await votingEscrow.createLock(
                parseEther("10"),
                startWeek + WEEK,
                constants.AddressZero,
                constants.HashZero
            );
            advanceBlockAtTime(startWeek + WEEK * 2);
            await expect(
                votingEscrow.increaseUnlockTime(
                    startWeek + WEEK * 5,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Lock expire");
        });

        it("Should revert with only increase lock duration", async function () {
            await votingEscrow.createLock(
                parseEther("10"),
                startWeek + WEEK,
                constants.AddressZero,
                constants.HashZero
            );
            await expect(
                votingEscrow.increaseUnlockTime(
                    startWeek + WEEK,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Can only increase lock duration");
        });

        it("Should revert with more than max time lock", async function () {
            await votingEscrow.createLock(
                parseEther("10"),
                startWeek + WEEK,
                constants.AddressZero,
                constants.HashZero
            );
            await expect(
                votingEscrow.increaseUnlockTime(
                    startWeek + 365 * 5 * DAY,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.revertedWith("Voting lock cannot exceed max lock time");
        });

        it("Should increase unlock time for user1", async function () {
            const lockAmount = parseEther("10");
            const unlockTime = startWeek + WEEK * 10;
            const newUnlockTime = unlockTime + WEEK * 2;
            await votingEscrow.createLock(
                lockAmount,
                unlockTime,
                constants.AddressZero,
                constants.HashZero
            );
            advanceBlockAtTime(unlockTime - WEEK);

            await expect(
                votingEscrow.increaseUnlockTime(
                    newUnlockTime,
                    constants.AddressZero,
                    constants.HashZero
                )
            )
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
            await votingEscrow.createLock(
                lockAmount,
                unlockTime,
                constants.AddressZero,
                constants.HashZero
            );
            await expect(votingEscrow.withdraw()).to.revertedWith("The lock is not expired");
        });

        it("Should increase unlock time for user1", async function () {
            const lockAmount = parseEther("10");
            const unlockTime = startWeek + WEEK * 10;
            await votingEscrow.createLock(
                lockAmount,
                unlockTime,
                constants.AddressZero,
                constants.HashZero
            );
            advanceBlockAtTime(unlockTime);

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
            await votingEscrow
                .connect(user1)
                .createLock(lockAmount1, unlockTime1, constants.AddressZero, constants.HashZero);
            await votingEscrow
                .connect(user2)
                .createLock(lockAmount2, unlockTime2, constants.AddressZero, constants.HashZero);
            await votingEscrow
                .connect(user3)
                .createLock(lockAmount3, unlockTime3, constants.AddressZero, constants.HashZero);

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
        let dropTimeBefore: BigNumber;

        beforeEach(async function () {
            lockAmount = parseEther("10");
            threshold = lockAmount.div(3);
            unlockTime = startWeek + WEEK * 10;
            dropTimeBefore = calculateDropBelowTime(unlockTime, threshold, lockAmount);

            await votingEscrow.createLock(
                lockAmount,
                unlockTime,
                constants.AddressZero,
                constants.HashZero
            );
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
                unlockTime - MAX_TIME.toNumber()
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
            expect(dropTimeBefore.toNumber()).to.be.lessThan(lowerThresholdDropTime.toNumber());
            expect(dropTimeBefore.toNumber()).to.be.greaterThan(higherThresholdDropTime.toNumber());
        });

        it("Drop below time should increase after increaseAmount", async function () {
            const lockAmount2 = parseEther("5");
            const totalLockAmount = lockAmount.add(lockAmount2);
            const dropTimeAfterDepositFor = calculateDropBelowTime(
                unlockTime,
                threshold,
                totalLockAmount
            );

            await votingEscrow.increaseAmount(
                addr1,
                lockAmount2,
                constants.AddressZero,
                constants.HashZero
            );
            expect(await votingEscrow.getTimestampDropBelow(addr1, threshold)).to.be.equal(
                dropTimeAfterDepositFor
            );

            expect(dropTimeBefore.toNumber()).to.be.lessThan(dropTimeAfterDepositFor.toNumber());
        });

        it("Drop below time should increase after increaseUnlockTime", async function () {
            const newUnlockTime = unlockTime + WEEK * 2;
            const dropTimeAfterDepositFor = calculateDropBelowTime(
                newUnlockTime,
                threshold,
                lockAmount
            );

            await votingEscrow.increaseUnlockTime(
                newUnlockTime,
                constants.AddressZero,
                constants.HashZero
            );
            expect(await votingEscrow.getTimestampDropBelow(addr1, threshold)).to.be.equal(
                dropTimeAfterDepositFor
            );

            expect(dropTimeBefore.toNumber()).to.be.lessThan(dropTimeAfterDepositFor.toNumber());
        });
    });

    describe("updateAddressWhitelist()", function () {
        let newWhitelist: MockContract;
        let someContract: MockContract;

        beforeEach(async function () {
            newWhitelist = await deployMockForName(owner, "IAddressWhitelist");
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
            ).to.be.revertedWith("Smart contract whitelist has to be null or a contract");
        });

        it("Should reject non-whitelisted contract to create lock", async function () {
            await newWhitelist.mock.check.withArgs(someContract.address).returns(false);
            await votingEscrow.connect(owner).updateAddressWhitelist(newWhitelist.address);
            await expect(
                someContract.call(
                    votingEscrow,
                    "createLock",
                    parseEther("10"),
                    startWeek + WEEK * 10,
                    constants.AddressZero,
                    constants.HashZero
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
                    startWeek + WEEK * 10,
                    constants.AddressZero,
                    constants.HashZero
                )
            ).to.callMocks({
                func: newWhitelist.mock.check.withArgs(someContract.address),
                rets: [true],
            });
        });
    });
});
