import { expect } from "chai";
import { MockProvider } from "ethereum-waffle";
import type { Contract, Wallet } from "ethers";
import { BigNumber } from "ethers";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseUnits, parseEther } = ethers.utils;
const parsePrice = (value: string) => parseUnits(value, 6);

// These constants should match those in the contract.
const BATCH_SIZE = 30;
const EPOCH = BATCH_SIZE * 60;
const SECONDARY_SOURCE_DELAY = EPOCH * 2;
const OWNER_DELAY = EPOCH * 4;
const MAX_MESSAGE_DISTANCE = 3;
const PUBLISHING_DELAY = 15 * 60;

// These are helper constants used in test cases.
const SYMBOL = "TEST_SYMBOL";
const PRICES: BigNumber[] = [];
for (let i = 0; i < BATCH_SIZE; i++) {
    PRICES.push(parsePrice((20000 + i).toString()));
}
const PRICES_AVG = parseEther((40000 + BATCH_SIZE - 1).toString()).div(2);

async function advanceBlockAtTime(time: number) {
    await ethers.provider.send("evm_mine", [time]);
}

async function signMessage(wallet: Wallet, timestamp: BigNumber, symbol: string, price: BigNumber) {
    const message = ethers.utils.defaultAbiCoder.encode(
        ["string", "uint256", "string", "uint256"],
        ["prices", timestamp, symbol, price]
    );
    const signature = await wallet.signMessage(
        ethers.utils.arrayify(ethers.utils.keccak256(message))
    );
    return ethers.utils.splitSignature(signature);
}

async function signMessages(
    wallet: Wallet,
    timestamp: number | BigNumber,
    symbol: string,
    prices: BigNumber[]
) {
    expect(prices).to.have.lengthOf(BATCH_SIZE);
    const rList = [];
    const sList = [];
    let packedV = BigNumber.from(0);
    let vShift = 0;
    let currTimestamp = BigNumber.from(timestamp).sub(EPOCH);
    for (let i = 0; i < BATCH_SIZE; i++) {
        currTimestamp = currTimestamp.add(60);
        if (prices[i].isZero()) {
            rList.push("0x" + "0".repeat(64));
            sList.push("0x" + "0".repeat(64));
        } else {
            const { r, s, v } = await signMessage(wallet, currTimestamp, symbol, prices[i]);
            rList.push(r);
            sList.push(s);
            packedV = packedV.or(BigNumber.from(v).shl(vShift));
        }
        vShift += 8;
    }
    return [rList, sList, packedV];
}

describe("TwapOracle", function () {
    let sender: Wallet;
    let primarySource: Wallet;
    let secondarySource: Wallet;
    let owner: Wallet;
    let contract: Contract;
    let startTimestamp: number;
    let gasUsedInPrimaryUpdate: number;

    async function fixture(_wallets: Wallet[], provider: MockProvider) {
        const [sender, primarySource, secondarySource, owner] = provider.getWallets();
        let startTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        startTimestamp = Math.ceil(startTimestamp / EPOCH) * EPOCH + EPOCH;
        await advanceBlockAtTime(startTimestamp);
        const TwapOracle = (await ethers.getContractFactory("TwapOracle")).connect(owner);
        const contract = await TwapOracle.deploy(
            primarySource.address,
            secondarySource.address,
            SYMBOL
        );
        return {
            wallets: { sender, primarySource, secondarySource, owner },
            contract,
            startTimestamp,
        };
    }

    beforeEach(async function () {
        const f = await loadFixture(fixture);
        sender = f.wallets.sender;
        primarySource = f.wallets.primarySource;
        secondarySource = f.wallets.secondarySource;
        owner = f.wallets.owner;
        contract = f.contract;
        startTimestamp = f.startTimestamp;
    });

    async function callPrimary(timestamp: number | BigNumber, prices: BigNumber[]) {
        const [rList, sList, packedV] = await signMessages(
            primarySource,
            timestamp,
            SYMBOL,
            prices
        );
        return contract.updateTwapFromPrimary(timestamp, prices, rList, sList, packedV);
    }

    async function callSecondary(timestamp: number | BigNumber, prices: BigNumber[]) {
        const [rList, sList, packedV] = await signMessages(
            secondarySource,
            timestamp,
            SYMBOL,
            prices
        );
        return contract.updateTwapFromSecondary(timestamp, prices, rList, sList, packedV);
    }

    describe("updateTwapFromPrimary()", function () {
        it("Should accept data for a epoch in the past", async function () {
            await callPrimary(startTimestamp - EPOCH, PRICES);
        });

        it("Should accept data for the last epoch", async function () {
            await callPrimary(startTimestamp + EPOCH, PRICES);
        });

        it("Should accept data for a epoch in the future", async function () {
            await callPrimary(startTimestamp + EPOCH * 10, PRICES);
        });

        it("Should reject unaligned timestamp", async function () {
            await expect(callPrimary(startTimestamp - 1, PRICES)).to.be.revertedWith(
                "Unaligned timestamp"
            );
        });
    });

    describe("updateTwapFromSecondary()", async function () {
        it("Should reject data for a epoch in the past", async function () {
            const t = startTimestamp - EPOCH * 10;
            await expect(callSecondary(t, PRICES)).to.be.revertedWith(
                "The secondary source cannot update epoch before this contract is deployed"
            );
        });

        it("Should reject data before the secondary delay expires", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + SECONDARY_SOURCE_DELAY - 30);
            await expect(callSecondary(t, PRICES)).to.be.revertedWith(
                "Not ready for the secondary source"
            );
        });

        it("Should accept data after the owner delay expires", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + SECONDARY_SOURCE_DELAY);
            await callSecondary(t, PRICES);
        });

        it("Should reject unaligned timestamp", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + SECONDARY_SOURCE_DELAY);
            await expect(callSecondary(t - 1, PRICES)).to.be.revertedWith("Unaligned timestamp");
        });

        it("Should detect timestamp overflow", async function () {
            const t = BigNumber.from("2").pow(256).sub(1).div(EPOCH).mul(EPOCH);
            await expect(callSecondary(t, PRICES)).to.be.revertedWith(
                "Not ready for the secondary source"
            );
        });
    });

    describe("updateTwapFromOwner()", async function () {
        beforeEach(async function () {
            contract = await contract.connect(owner);
        });

        it("Should reject data for a epoch in the past", async function () {
            const t = startTimestamp - EPOCH * 10;
            await expect(contract.updateTwapFromOwner(t, parsePrice("20000"))).to.be.revertedWith(
                "Owner cannot update epoch before this contract is deployed"
            );
        });

        it("Should reject data before the owner delay expires", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + OWNER_DELAY - 30);
            await expect(contract.updateTwapFromOwner(t, parsePrice("20000"))).to.be.revertedWith(
                "Not ready for owner"
            );
        });

        it("Should reject data following an uninitialized epoch", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + OWNER_DELAY);
            await expect(contract.updateTwapFromOwner(t, parsePrice("20000"))).to.be.revertedWith(
                "Owner can only update a epoch following an updated epoch"
            );
        });

        it("Should reject data deviating too much", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + OWNER_DELAY);
            await callPrimary(t - EPOCH, Array(BATCH_SIZE).fill(parsePrice("20000")));
            await expect(contract.updateTwapFromOwner(t, parsePrice("2000"))).to.be.revertedWith(
                "Owner price deviates too much from the last price"
            );
            await expect(contract.updateTwapFromOwner(t, parsePrice("200000"))).to.be.revertedWith(
                "Owner price deviates too much from the last price"
            );
        });

        it("Should reject data if not called by owner", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + OWNER_DELAY);
            await callPrimary(t - EPOCH, PRICES);
            await expect(
                contract.connect(sender).updateTwapFromOwner(t, parseEther("20000"))
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject unaligned timestamp", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + OWNER_DELAY);
            await callPrimary(t - EPOCH, PRICES);
            await expect(
                contract.updateTwapFromOwner(t - 1, parseEther("20000"))
            ).to.be.revertedWith("Unaligned timestamp");
        });

        it("Should detect timestamp overflow", async function () {
            const t = BigNumber.from("2").pow(256).sub(1).div(EPOCH).mul(EPOCH);
            await expect(contract.updateTwapFromOwner(t, parseEther("20000"))).to.be.revertedWith(
                "Not ready for owner"
            );
        });

        it("Should accept valid data", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + OWNER_DELAY);
            await callPrimary(t - EPOCH, PRICES);
            await contract.updateTwapFromOwner(t, parseEther("20000"));
        });
    });

    describe("getTwap()", function () {
        describe("Publishing delay", function () {
            it("Should return zero for uninitialized epochs", async function () {
                const t1 = startTimestamp - EPOCH * 10;
                expect(await contract.getTwap(t1)).to.equal(0);
                const t2 = startTimestamp;
                expect(await contract.getTwap(t2)).to.equal(0);
                const t3 = startTimestamp + EPOCH * 10;
                expect(await contract.getTwap(t3)).to.equal(0);
            });

            it("Should return data from primary source after delay", async function () {
                const t = startTimestamp + EPOCH * 10;
                advanceBlockAtTime(t);
                await callPrimary(t, PRICES);
                advanceBlockAtTime(t + PUBLISHING_DELAY - 30);
                expect(await contract.getTwap(t)).to.equal(0);
                advanceBlockAtTime(t + PUBLISHING_DELAY);
                expect(await contract.getTwap(t)).to.equal(PRICES_AVG);
            });

            it("Should return data from secondary source after delay", async function () {
                const t = startTimestamp + EPOCH * 10;
                advanceBlockAtTime(t + SECONDARY_SOURCE_DELAY);
                await callSecondary(t, PRICES);
                advanceBlockAtTime(t + SECONDARY_SOURCE_DELAY + PUBLISHING_DELAY - 30);
                expect(await contract.getTwap(t)).to.equal(0);
                advanceBlockAtTime(t + SECONDARY_SOURCE_DELAY + PUBLISHING_DELAY);
                expect(await contract.getTwap(t)).to.equal(PRICES_AVG);
            });

            it("Should immediately return primary source data submitted late", async function () {
                const t = startTimestamp + EPOCH * 10;
                advanceBlockAtTime(t + EPOCH * 20);
                await callPrimary(t, PRICES);
                expect(await contract.getTwap(t)).to.equal(PRICES_AVG);
            });

            it("Should immediately return secondary source data submitted late", async function () {
                const t = startTimestamp + EPOCH * 10;
                advanceBlockAtTime(t + EPOCH * 20);
                await callSecondary(t, PRICES);
                expect(await contract.getTwap(t)).to.equal(PRICES_AVG);
            });

            it("Should immediately return data from owner", async function () {
                const t = startTimestamp + EPOCH * 10;
                advanceBlockAtTime(t + OWNER_DELAY);
                await callPrimary(t - EPOCH, PRICES);
                await contract.connect(owner).updateTwapFromOwner(t, parseEther("20000"));
                expect(await contract.getTwap(t)).to.equal(parseEther("20000"));
            });
        });

        describe("Averaging", function () {
            let pricesWithHoles: BigNumber[];
            let avgWithHoles: BigNumber;

            before(function () {
                if (BATCH_SIZE < 10 || MAX_MESSAGE_DISTANCE < 3) this.skip();
                const ps = [];
                let sum = BigNumber.from(0);
                for (let i = 0; i < BATCH_SIZE; i++) {
                    const p = parsePrice((10000 + i * i * 1000).toString());
                    ps.push(p);
                    sum = sum.add(p);
                }
                // dig a hole at the beginning, which will use the next price
                sum = sum.sub(ps[0]).add(ps[2]);
                sum = sum.sub(ps[1]).add(ps[2]);
                ps[0] = BigNumber.from(0);
                ps[1] = BigNumber.from(0);
                // dig a hole in the middle, which will use the next price
                sum = sum.sub(ps[3]).add(ps[4]);
                ps[3] = BigNumber.from(0);
                // dig a hole at the end, which will use the previous price
                sum = sum.sub(ps[BATCH_SIZE - 1]).add(ps[BATCH_SIZE - 2]);
                ps[BATCH_SIZE - 1] = BigNumber.from(0);
                pricesWithHoles = ps;
                avgWithHoles = sum.mul(1e12).div(BATCH_SIZE);
            });

            it("Should compute TWAP from primary source", async function () {
                const t = startTimestamp + EPOCH * 10;
                advanceBlockAtTime(t + EPOCH * 20);
                await callPrimary(t, pricesWithHoles);
                expect(await contract.getTwap(t)).to.equal(avgWithHoles);
            });

            it("Should compute TWAP from secondary source", async function () {
                const t = startTimestamp + EPOCH * 10;
                advanceBlockAtTime(t + EPOCH * 20);
                await callSecondary(t, pricesWithHoles);
                expect(await contract.getTwap(t)).to.equal(avgWithHoles);
            });
        });
    });

    describe("Updating the same epoch", function () {
        let existingEpoch: number;
        let incompletePrices: BigNumber[];
        let incompleteMorePrices: BigNumber[];

        beforeEach(function () {
            if (BATCH_SIZE < 10 || MAX_MESSAGE_DISTANCE < 3) this.skip();
            existingEpoch = startTimestamp + EPOCH * 10;
            incompletePrices = PRICES.slice();
            incompletePrices[0] = BigNumber.from(0);
            incompletePrices[2] = BigNumber.from(0);
            incompletePrices[3] = BigNumber.from(0);
            incompletePrices[BATCH_SIZE - 3] = BigNumber.from(0);
            incompletePrices[BATCH_SIZE - 2] = BigNumber.from(0);
            incompleteMorePrices = PRICES.slice();
            incompleteMorePrices[1] = BigNumber.from(0);
            incompleteMorePrices[2] = BigNumber.from(0);
            incompleteMorePrices[BATCH_SIZE - 4] = BigNumber.from(0);
        });

        describe("Intialized by primary source", function () {
            beforeEach(async function () {
                advanceBlockAtTime(existingEpoch);
                await callPrimary(existingEpoch, incompletePrices);
            });

            it("Should reject primary source after the publishing delay", async function () {
                advanceBlockAtTime(existingEpoch + PUBLISHING_DELAY + EPOCH * 10);
                await expect(callPrimary(existingEpoch, PRICES)).to.be.revertedWith(
                    "Too late for the primary source to update an existing epoch"
                );
            });

            it("Should reject less or equal number of messages", async function () {
                const prices = incompletePrices.slice();
                await expect(callPrimary(existingEpoch, prices)).to.be.revertedWith(
                    "More messages are required to update an existing epoch"
                );
                prices[5] = BigNumber.from(0);
                await expect(callPrimary(existingEpoch, prices)).to.be.revertedWith(
                    "More messages are required to update an existing epoch"
                );
            });

            it("Should reject update from secondary source", async function () {
                advanceBlockAtTime(existingEpoch + SECONDARY_SOURCE_DELAY);
                await expect(callSecondary(existingEpoch, PRICES)).to.be.revertedWith(
                    "Too late for the secondary source to update an existing epoch"
                );
            });

            it("Should reject update from owner", async function () {
                advanceBlockAtTime(existingEpoch + OWNER_DELAY);
                await expect(
                    contract.connect(owner).updateTwapFromOwner(existingEpoch, parsePrice("20000"))
                ).to.be.revertedWith("Owner cannot update an existing epoch");
            });

            it("Should accept more messages", async function () {
                advanceBlockAtTime(existingEpoch + PUBLISHING_DELAY - 30);
                await callPrimary(existingEpoch, incompleteMorePrices);
                await callPrimary(existingEpoch, PRICES);
                advanceBlockAtTime(existingEpoch + PUBLISHING_DELAY);
                expect(await contract.getTwap(existingEpoch)).to.equal(PRICES_AVG);
            });
        });

        describe("Intialized by secondary source", function () {
            beforeEach(async function () {
                advanceBlockAtTime(existingEpoch + SECONDARY_SOURCE_DELAY);
                await callSecondary(existingEpoch, incompletePrices);
            });

            it("Should reject secondary source after the publishing delay", async function () {
                advanceBlockAtTime(
                    existingEpoch + SECONDARY_SOURCE_DELAY + PUBLISHING_DELAY + EPOCH * 10
                );
                await expect(callSecondary(existingEpoch, PRICES)).to.be.revertedWith(
                    "Too late for the secondary source to update an existing epoch"
                );
            });

            it("Should reject less or equal number of messages", async function () {
                const prices = incompletePrices.slice();
                await expect(callSecondary(existingEpoch, prices)).to.be.revertedWith(
                    "More messages are required to update an existing epoch"
                );
                prices[5] = BigNumber.from(0);
                await expect(callSecondary(existingEpoch, prices)).to.be.revertedWith(
                    "More messages are required to update an existing epoch"
                );
            });

            it("Should reject update from primary source", async function () {
                await expect(callPrimary(existingEpoch, PRICES)).to.be.revertedWith(
                    "Too late for the primary source to update an existing epoch"
                );
            });

            it("Should reject update from owner", async function () {
                advanceBlockAtTime(existingEpoch + OWNER_DELAY);
                await expect(
                    contract.connect(owner).updateTwapFromOwner(existingEpoch, parsePrice("20000"))
                ).to.be.revertedWith("Owner cannot update an existing epoch");
            });

            it("Should accept more messages", async function () {
                advanceBlockAtTime(existingEpoch + SECONDARY_SOURCE_DELAY + PUBLISHING_DELAY - 30);
                await callSecondary(existingEpoch, incompleteMorePrices);
                await callSecondary(existingEpoch, PRICES);
                advanceBlockAtTime(existingEpoch + SECONDARY_SOURCE_DELAY + PUBLISHING_DELAY);
                expect(await contract.getTwap(existingEpoch)).to.equal(PRICES_AVG);
            });
        });
    });

    describe("Too many continuous missing messages", function () {
        let missingAtTheBeginning: BigNumber[];
        let missingInTheMiddle: BigNumber[];
        let missingAtTheEnd: BigNumber[];

        before(function () {
            if (MAX_MESSAGE_DISTANCE <= 0) this.skip();
            missingAtTheBeginning = PRICES.slice();
            missingInTheMiddle = PRICES.slice();
            missingAtTheEnd = PRICES.slice();
            for (let i = 0; i < MAX_MESSAGE_DISTANCE; i++) {
                missingAtTheBeginning[i] = BigNumber.from(0);
                missingInTheMiddle[i + 1] = BigNumber.from(0);
                missingAtTheEnd[BATCH_SIZE - i - 1] = BigNumber.from(0);
            }
        });

        it("Primary", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + EPOCH * 10);
            await expect(callPrimary(t, missingAtTheBeginning)).to.be.revertedWith(
                "Too many continuous missing messages"
            );
            await expect(callPrimary(t, missingInTheMiddle)).to.be.revertedWith(
                "Too many continuous missing messages"
            );
            await expect(callPrimary(t, missingAtTheEnd)).to.be.revertedWith(
                "Too many continuous missing messages"
            );
        });

        it("Secondary", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + EPOCH * 10);
            await expect(callSecondary(t, missingAtTheBeginning)).to.be.revertedWith(
                "Too many continuous missing messages"
            );
            await expect(callSecondary(t, missingInTheMiddle)).to.be.revertedWith(
                "Too many continuous missing messages"
            );
            await expect(callSecondary(t, missingAtTheEnd)).to.be.revertedWith(
                "Too many continuous missing messages"
            );
        });
    });

    describe("Invalid signature", function () {
        it("Primary", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + EPOCH * 10);
            const [rList, sList, packedV] = await signMessages(secondarySource, t, SYMBOL, PRICES);
            await expect(
                contract.updateTwapFromPrimary(t, PRICES, rList, sList, packedV)
            ).to.be.revertedWith("Invalid signature");
        });

        it("Secondary", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t + EPOCH * 10);
            const [rList, sList, packedV] = await signMessages(primarySource, t, SYMBOL, PRICES);
            await expect(
                contract.updateTwapFromSecondary(t, PRICES, rList, sList, packedV)
            ).to.be.revertedWith("Invalid signature");
        });
    });

    describe("Gas used", function () {
        it("Measures gas used for update from primary source", async function () {
            const t = startTimestamp + EPOCH;
            advanceBlockAtTime(t);
            const tx = await callPrimary(t, PRICES);
            const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
            gasUsedInPrimaryUpdate = receipt.gasUsed.toNumber();
        });
    });

    after(async () => {
        console.log("Gas used in a normal update:", gasUsedInPrimaryUpdate);
    });
});
