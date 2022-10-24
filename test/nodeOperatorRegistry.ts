import { expect } from "chai";
import { BigNumber, Contract, Wallet } from "ethers";
import type { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { deployMockForName } from "./mock";
import { FixtureWalletMap } from "./utils";

const PUBKEY1 = "0x" + "123".repeat(32);
const PUBKEY2 = "0x" + "456".repeat(32);
const PUBKEY3 = "0x" + "789".repeat(32);
const PUBKEY4 = "0x" + "abc".repeat(32);
const SIGNATURE1 = "0x" + "321".repeat(64);
const SIGNATURE2 = "0x" + "654".repeat(64);
const SIGNATURE3 = "0x" + "987".repeat(64);
const SIGNATURE4 = "0x" + "cba".repeat(64);

function concatBytes(...bytes: string[]): string {
    let s = "0x";
    for (const b of bytes) {
        s = s.concat(b.slice(2));
    }
    return s;
}

describe("NodeOperatorRegistry", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly strategy: MockContract;
        readonly registry: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let operator0: Wallet;
    let operator1: Wallet;
    let owner: Wallet;
    let addr1: string;
    let strategy: MockContract;
    let registry: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, operator0, operator1, owner] = provider.getWallets();

        const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
        const weth = await MockWrappedToken.connect(owner).deploy("Wrapped ETH", "WETH");

        const fund = await deployMockForName(owner, "FundV4");
        await fund.mock.tokenUnderlying.returns(weth.address);
        const strategy = await deployMockForName(owner, "EthStakingStrategy");
        await strategy.mock.fund.returns(fund.address);

        const WithdrawalManager = await ethers.getContractFactory("WithdrawalManager");
        const withdrawalManager = await WithdrawalManager.connect(owner).deploy(strategy.address);
        const WithdrawalManagerFactory = await ethers.getContractFactory(
            "WithdrawalManagerFactory"
        );
        const withdrawalManagerFactory = await WithdrawalManagerFactory.connect(owner).deploy(
            withdrawalManager.address
        );

        const NodeOperatorRegistry = await ethers.getContractFactory("NodeOperatorRegistry");
        const nodeOperatorRegistry = await NodeOperatorRegistry.connect(owner).deploy(
            strategy.address,
            withdrawalManagerFactory.address
        );

        await nodeOperatorRegistry.addOperator("Operator0", operator0.address);
        await nodeOperatorRegistry.addOperator("Operator1", operator1.address);
        await nodeOperatorRegistry
            .connect(operator0)
            .addKeys(
                0,
                concatBytes(PUBKEY1, PUBKEY2, PUBKEY3, PUBKEY4),
                concatBytes(SIGNATURE1, SIGNATURE2, SIGNATURE3, SIGNATURE4)
            );

        return {
            wallets: { user1, operator0, operator1, owner },
            strategy,
            registry: nodeOperatorRegistry.connect(user1),
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function expectKey(key: any, pubkey: string, signature: string) {
        expect(key.pubkey0).to.equal(pubkey.slice(0, 66));
        expect(key.pubkey1).to.equal("0x" + pubkey.slice(66) + "0".repeat(32));
        expect(key.signature0).to.equal(signature.slice(0, 66));
        expect(key.signature1).to.equal("0x" + signature.slice(66, 130));
        expect(key.signature2).to.equal("0x" + signature.slice(130));
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        operator0 = fixtureData.wallets.operator0;
        operator1 = fixtureData.wallets.operator1;
        owner = fixtureData.wallets.owner;
        addr1 = user1.address;
        strategy = fixtureData.strategy;
        registry = fixtureData.registry;
    });

    describe("addOperator()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(registry.addOperator("NewOp", addr1)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should add new operator", async function () {
            expect(await registry.operatorCount()).to.equal(2);
            await registry.connect(owner).addOperator("NewOp", addr1);
            expect(await registry.operatorCount()).to.equal(3);
            const op = await registry.getOperator(2);
            expect(op.operatorOwner).to.equal(addr1);
            expect(op.name).to.equal("NewOp");
            expect(op.rewardAddress).to.equal(addr1);
            expect(op.keyStat.totalCount).to.equal(0);
            expect(op.keyStat.usedCount).to.equal(0);
            expect(op.keyStat.verifiedCount).to.equal(0);
            expect(op.keyStat.depositLimit).to.equal(0);
        });

        it("Should deploy a withdrawal manager", async function () {
            await registry.connect(owner).addOperator("NewOp", addr1);
            const op = await registry.getOperator(2);
            expect(await registry.getWithdrawalAddress(2)).equal(op.withdrawalAddress);
            const withdrawalManager = await ethers.getContractAt(
                "WithdrawalManager",
                op.withdrawalAddress
            );
            expect(await withdrawalManager.operatorID()).to.equal(2);
            expect(BigNumber.from(await registry.getWithdrawalCredential(2))).to.equal(
                BigNumber.from(op.withdrawalAddress).add(BigNumber.from(1).shl(248))
            );
        });

        it("Should emit an event", async function () {
            await expect(registry.connect(owner).addOperator("NewOp", addr1))
                .to.emit(registry, "OperatorAdded")
                .withArgs(2, "NewOp", addr1);
        });
    });

    describe("addKeys()", function () {
        beforeEach(async function () {
            registry = registry.connect(operator1);
        });

        it("Should revert if not called by operator owner", async function () {
            await expect(registry.addKeys(0, "0x", "0x")).to.be.revertedWith("Only operator owner");
            await expect(registry.connect(owner).addKeys(1, "0x", "0x")).to.be.revertedWith(
                "Only operator owner"
            );
        });

        it("Should reject incompelete input", async function () {
            await expect(registry.addKeys(1, "0x1234", "0x")).to.be.revertedWith(
                "Invalid param length"
            );
            await expect(
                registry.addKeys(1, PUBKEY1, SIGNATURE1.concat("1234"))
            ).to.be.revertedWith("Invalid param length");
        });

        it("Should reject zero pubkey or signature", async function () {
            await expect(
                registry.addKeys(
                    1,
                    concatBytes(PUBKEY1, "0x" + "0".repeat(96), PUBKEY3),
                    concatBytes(SIGNATURE1, SIGNATURE2, SIGNATURE3)
                )
            ).to.be.revertedWith("Empty pubkey or signature");
            await expect(
                registry.addKeys(
                    1,
                    concatBytes(PUBKEY1, PUBKEY2, PUBKEY3),
                    concatBytes(SIGNATURE1, "0x" + "0".repeat(192), SIGNATURE3)
                )
            ).to.be.revertedWith("Empty pubkey or signature");
        });

        it("Should add a single key", async function () {
            await registry.addKeys(1, PUBKEY3, SIGNATURE3);
            expect((await registry.getKeyStat(1)).totalCount).to.equal(1);
            const pubkeys = await registry.getPubkeys(1, 0, 1);
            expect(pubkeys[0]).to.equal(PUBKEY3);
            const key = await registry.getKey(1, 0);
            expectKey(key, PUBKEY3, SIGNATURE3);
        });

        it("Should add multiple keys", async function () {
            await registry.addKeys(1, PUBKEY4, SIGNATURE4);
            await registry.addKeys(
                1,
                concatBytes(PUBKEY3, PUBKEY2, PUBKEY1),
                concatBytes(SIGNATURE3, SIGNATURE2, SIGNATURE1)
            );
            expect((await registry.getKeyStat(1)).totalCount).to.equal(4);
            const pubkeys = await registry.getPubkeys(1, 0, 4);
            expect(pubkeys[0]).to.equal(PUBKEY4);
            expect(pubkeys[1]).to.equal(PUBKEY3);
            expect(pubkeys[2]).to.equal(PUBKEY2);
            expect(pubkeys[3]).to.equal(PUBKEY1);
            const key = await registry.getKey(1, 2);
            expectKey(key, PUBKEY2, SIGNATURE2);
        });

        it("Should emit events", async function () {
            await registry.addKeys(
                1,
                concatBytes(PUBKEY4, PUBKEY3, PUBKEY2),
                concatBytes(SIGNATURE4, SIGNATURE3, SIGNATURE2)
            );
            await expect(registry.addKeys(1, PUBKEY1, SIGNATURE1))
                .to.emit(registry, "KeyAdded")
                .withArgs(1, PUBKEY1, 3);
        });
    });

    describe("useKeys()", function () {
        beforeEach(async function () {
            await registry.connect(operator0).updateDepositLimit(0, 3);
            await registry.connect(owner).updateVerifiedCount(0, 4);
        });

        it("Should revert if not called by strategy", async function () {
            await expect(registry.useKeys(0, 0)).to.be.revertedWith("Only strategy");
        });

        it("Should revert if there are no enough keys", async function () {
            await expect(strategy.call(registry, "useKeys", 0, 4)).to.be.revertedWith(
                "No enough pubkeys"
            );
            await registry.connect(owner).updateVerifiedCount(0, 2);
            await expect(strategy.call(registry, "useKeys", 0, 3)).to.be.revertedWith(
                "No enough pubkeys"
            );
        });

        it("Should return keys and withdraw credential", async function () {
            const withdrawalCredential = await registry.getWithdrawalCredential(0);

            const tx1 = await registry.populateTransaction.useKeys(0, 1);
            const raw1 = await ethers.provider.call({ ...tx1, from: strategy.address });
            const ret1 = registry.interface.decodeFunctionResult("useKeys", raw1);
            expect(ret1[0].length).to.equal(1);
            expectKey(ret1[0][0], PUBKEY1, SIGNATURE1);
            expect(ret1.withdrawalCredential).to.equal(withdrawalCredential);

            await strategy.call(registry, "useKeys", 0, 1);
            const tx2 = await registry.populateTransaction.useKeys(0, 2);
            const raw2 = await ethers.provider.call({ ...tx2, from: strategy.address });
            const ret2 = registry.interface.decodeFunctionResult("useKeys", raw2);
            expect(ret2[0].length).to.equal(2);
            expectKey(ret2[0][0], PUBKEY2, SIGNATURE2);
            expectKey(ret2[0][1], PUBKEY3, SIGNATURE3);
            expect(ret2.withdrawalCredential).to.equal(withdrawalCredential);
        });

        it("Should update used count", async function () {
            await strategy.call(registry, "useKeys", 0, 1);
            expect((await registry.getKeyStat(0)).usedCount).to.equal(1);
            await strategy.call(registry, "useKeys", 0, 2);
            expect((await registry.getKeyStat(0)).usedCount).to.equal(3);
        });

        it("Should emit an event", async function () {
            await expect(strategy.call(registry, "useKeys", 0, 1))
                .to.emit(registry, "KeyUsed")
                .withArgs(0, 1);
            await expect(strategy.call(registry, "useKeys", 0, 2))
                .to.emit(registry, "KeyUsed")
                .withArgs(0, 2);
        });
    });

    describe("truncateUnusedKeys()", function () {
        beforeEach(async function () {
            await registry.connect(operator0).updateDepositLimit(0, 2);
            await registry.connect(owner).updateVerifiedCount(0, 3);
            await strategy.call(registry, "useKeys", 0, 1);
        });

        it("Should revert if not called by operator owner", async function () {
            await expect(registry.truncateUnusedKeys(0)).to.be.revertedWith("Only operator owner");
            await expect(registry.connect(operator0).truncateUnusedKeys(1)).to.be.revertedWith(
                "Only operator owner"
            );
        });

        it("Should update total count and verified count", async function () {
            await registry.connect(operator0).truncateUnusedKeys(0);
            const keyStat = await registry.getKeyStat(0);
            expect(keyStat.totalCount).to.equal(1);
            expect(keyStat.usedCount).to.equal(1);
            expect(keyStat.verifiedCount).to.equal(1);
            expect(keyStat.depositLimit).to.equal(2);
        });

        it("Should emit an event", async function () {
            await expect(registry.connect(operator0).truncateUnusedKeys(0))
                .to.emit(registry, "KeyTruncated")
                .withArgs(0, 1);
        });
    });

    describe("truncateAllUnusedKeys()", function () {
        beforeEach(async function () {
            await registry.connect(operator0).updateDepositLimit(0, 2);
            await registry.connect(owner).updateVerifiedCount(0, 3);
            await strategy.call(registry, "useKeys", 0, 1);
        });

        it("Should revert if not called by owner", async function () {
            await expect(registry.truncateAllUnusedKeys()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should update total count and verified count", async function () {
            await registry.connect(owner).truncateAllUnusedKeys();
            const keyStat = await registry.getKeyStat(0);
            expect(keyStat.totalCount).to.equal(1);
            expect(keyStat.usedCount).to.equal(1);
            expect(keyStat.verifiedCount).to.equal(1);
            expect(keyStat.depositLimit).to.equal(2);
        });

        it("Should emit an event", async function () {
            await expect(registry.connect(owner).truncateAllUnusedKeys())
                .to.emit(registry, "KeyTruncated")
                .withArgs(0, 1);
        });
    });

    describe("updateRewardAddress()", function () {
        it("Should revert if not called by operator owner", async function () {
            await expect(registry.updateRewardAddress(0, addr1)).to.be.revertedWith(
                "Only operator owner"
            );
            await expect(
                registry.connect(operator0).updateRewardAddress(1, addr1)
            ).to.be.revertedWith("Only operator owner");
        });

        it("Should update reward address", async function () {
            await registry.connect(operator0).updateRewardAddress(0, addr1);
            expect(await registry.getRewardAddress(0)).to.equal(addr1);
        });

        it("Should emit an event", async function () {
            await expect(registry.connect(operator0).updateRewardAddress(0, addr1))
                .to.emit(registry, "RewardAddressUpdated")
                .withArgs(0, addr1);
        });
    });

    describe("updateOperatorOwner()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(registry.updateOperatorOwner(0, addr1)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should revert if operator ID is invalid", async function () {
            await expect(registry.connect(owner).updateOperatorOwner(9, addr1)).to.be.revertedWith(
                "Invalid operator ID"
            );
        });

        it("Should update operator owner", async function () {
            await registry.connect(owner).updateOperatorOwner(0, addr1);
            expect((await registry.getOperator(0)).operatorOwner).to.equal(addr1);
        });

        it("Should emit an event", async function () {
            await expect(registry.connect(owner).updateOperatorOwner(0, addr1))
                .to.emit(registry, "OperatorOwnerUpdated")
                .withArgs(0, addr1);
        });
    });

    describe("updateStrategy()", function () {
        it("Should revert if not called by owner", async function () {
            await expect(registry.updateStrategy(addr1)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("Should update strategy", async function () {
            await registry.connect(owner).updateStrategy(addr1);
            expect(await registry.strategy()).to.equal(addr1);
        });

        it("Should emit an event", async function () {
            await expect(registry.connect(owner).updateStrategy(addr1))
                .to.emit(registry, "StrategyUpdated")
                .withArgs(addr1);
        });
    });

    describe("Batch getters", function () {
        beforeEach(async function () {
            await registry.connect(operator0).updateDepositLimit(0, 2);
            await registry.connect(owner).updateVerifiedCount(0, 3);
            await strategy.call(registry, "useKeys", 0, 1);
        });

        it("getOperators()", async function () {
            const ops = await registry.getOperators();
            expect(ops[0].operatorOwner).to.equal(operator0.address);
            expect(ops[0].name).to.equal("Operator0");
            expect(ops[0].rewardAddress).to.equal(operator0.address);
            expect(ops[0].keyStat.totalCount).to.equal(4);
            expect(ops[0].keyStat.usedCount).to.equal(1);
            expect(ops[0].keyStat.verifiedCount).to.equal(3);
            expect(ops[0].keyStat.depositLimit).to.equal(2);
            const withdrawal0 = await ethers.getContractAt(
                "WithdrawalManager",
                ops[0].withdrawalAddress
            );
            expect(await withdrawal0.operatorID()).to.equal(0);
            expect(ops[1].operatorOwner).to.equal(operator1.address);
            expect(ops[1].name).to.equal("Operator1");
            expect(ops[1].rewardAddress).to.equal(operator1.address);
            expect(ops[1].keyStat.totalCount).to.equal(0);
            expect(ops[1].keyStat.usedCount).to.equal(0);
            expect(ops[1].keyStat.verifiedCount).to.equal(0);
            expect(ops[1].keyStat.depositLimit).to.equal(0);
            const withdrawal1 = await ethers.getContractAt(
                "WithdrawalManager",
                ops[1].withdrawalAddress
            );
            expect(await withdrawal1.operatorID()).to.equal(1);
        });

        it("getRewardAddresses()", async function () {
            expect(await registry.getRewardAddresses()).to.eql([
                operator0.address,
                operator1.address,
            ]);
        });

        it("getWithdrawalAddresses()", async function () {
            const addrs = await registry.getWithdrawalAddresses();
            expect(addrs.length).to.equal(2);
            const withdrawal0 = await ethers.getContractAt("WithdrawalManager", addrs[0]);
            expect(await withdrawal0.operatorID()).to.equal(0);
            const withdrawal1 = await ethers.getContractAt("WithdrawalManager", addrs[1]);
            expect(await withdrawal1.operatorID()).to.equal(1);
        });

        it("getKeyStats()", async function () {
            const keyStats = await registry.getKeyStats();
            expect(keyStats.length).to.equal(2);
            expect(keyStats[0].totalCount).to.equal(4);
            expect(keyStats[0].usedCount).to.equal(1);
            expect(keyStats[0].verifiedCount).to.equal(3);
            expect(keyStats[0].depositLimit).to.equal(2);
            expect(keyStats[1].totalCount).to.equal(0);
            expect(keyStats[1].usedCount).to.equal(0);
            expect(keyStats[1].verifiedCount).to.equal(0);
            expect(keyStats[1].depositLimit).to.equal(0);
        });

        it("getKeys()", async function () {
            const keys = await registry.getKeys(0, 1, 2);
            expect(keys.length).to.equal(2);
            expectKey(keys[0], PUBKEY2, SIGNATURE2);
            expectKey(keys[1], PUBKEY3, SIGNATURE3);
        });

        it("getSignatures()", async function () {
            expect(await registry.getSignatures(0, 1, 2)).to.eql([SIGNATURE2, SIGNATURE3]);
        });
    });
});
