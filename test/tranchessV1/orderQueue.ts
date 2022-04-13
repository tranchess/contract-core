import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import type { Fixture, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { FixtureWalletMap } from "./utils";

describe("LibOrderBook", function () {
    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly orderQueue: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let user3: Wallet;
    let addr1: string;
    let addr2: string;
    let addr3: string;
    let orderQueue: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, user3, owner] = provider.getWallets();

        const OrderQueue = await ethers.getContractFactory("OrderQueueTestWrapper");
        const orderQueue = await OrderQueue.connect(owner).deploy();

        return {
            wallets: { user1, user2, user3, owner },
            orderQueue,
        };
    }

    async function threeOrdersFixture(): Promise<FixtureData> {
        const f = await loadFixture(deployFixture);
        await orderQueue.append(addr1, 100, 3);
        await orderQueue.append(addr2, 200, 5);
        await orderQueue.append(addr3, 300, 7);
        return f;
    }

    before(function () {
        currentFixture = threeOrdersFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        user3 = fixtureData.wallets.user3;
        addr1 = user1.address;
        addr2 = user2.address;
        addr3 = user3.address;
        orderQueue = fixtureData.orderQueue;
    });

    describe("append()", function () {
        let outerFixture: Fixture<FixtureData>;

        before(function () {
            // Override fixture
            outerFixture = currentFixture;
            currentFixture = deployFixture;
        });

        after(function () {
            // Restore fixture
            currentFixture = outerFixture;
        });

        it("Should be an empty queue initially", async function () {
            expect(await orderQueue.isEmpty()).to.equal(true);
        });

        it("Should append the first order at index 1", async function () {
            await orderQueue.append(addr1, 100, 8);
            expect(await orderQueue.lastReturn()).to.equal(1);
            const queue = await orderQueue.queue();
            expect(queue.head).to.equal(1);
            expect(queue.tail).to.equal(1);
            expect(queue.counter).to.equal(1);
            const order = await orderQueue.getOrder(1);
            expect(order.prev).to.equal(0);
            expect(order.next).to.equal(0);
            expect(order.maker).to.equal(addr1);
            expect(order.amount).to.equal(100);
            expect(order.version).to.equal(8);
            expect(order.fillable).to.equal(100);
        });

        it("Should set correct links", async function () {
            await orderQueue.append(addr1, 100, 3);
            await orderQueue.append(addr2, 200, 5);
            await orderQueue.append(addr3, 300, 7);
            const queue = await orderQueue.queue();
            expect(queue.head).to.equal(1);
            expect(queue.tail).to.equal(3);
            expect(queue.counter).to.equal(3);
            const order1 = await orderQueue.getOrder(1);
            const order2 = await orderQueue.getOrder(2);
            const order3 = await orderQueue.getOrder(3);
            expect(order1.prev).to.equal(0);
            expect(order1.next).to.equal(2);
            expect(order1.maker).to.equal(addr1);
            expect(order2.prev).to.equal(1);
            expect(order2.next).to.equal(3);
            expect(order2.maker).to.equal(addr2);
            expect(order3.prev).to.equal(2);
            expect(order3.next).to.equal(0);
            expect(order3.maker).to.equal(addr3);
        });
    });

    describe("cancel()", function () {
        it("Should empty the queue when all orders are canceled", async function () {
            await orderQueue.cancel(1);
            await orderQueue.cancel(2);
            await orderQueue.cancel(3);
            expect(await orderQueue.isEmpty()).to.equal(true);
            const queue = await orderQueue.queue();
            expect(queue.head).to.equal(0);
            expect(queue.tail).to.equal(0);
            expect(queue.counter).to.equal(3);
        });

        it("Should delete the canceled order", async function () {
            await orderQueue.cancel(1);
            const order = await orderQueue.getOrder(1);
            expect(order.prev).to.equal(0);
            expect(order.next).to.equal(0);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.version).to.equal(0);
            expect(order.fillable).to.equal(0);
        });

        it("Should update links when the first order is canceled", async function () {
            await orderQueue.cancel(1);
            expect(await orderQueue.isEmpty()).to.equal(false);
            const queue = await orderQueue.queue();
            expect(queue.head).to.equal(2);
            expect(queue.tail).to.equal(3);
            expect((await orderQueue.getOrder(2)).prev).to.equal(0);
        });

        it("Should update links when the last order is canceled", async function () {
            await orderQueue.cancel(3);
            expect(await orderQueue.isEmpty()).to.equal(false);
            const queue = await orderQueue.queue();
            expect(queue.head).to.equal(1);
            expect(queue.tail).to.equal(2);
            expect((await orderQueue.getOrder(2)).next).to.equal(0);
        });

        it("Should update links when an order in the middle is canceled", async function () {
            await orderQueue.cancel(2);
            expect(await orderQueue.isEmpty()).to.equal(false);
            const queue = await orderQueue.queue();
            expect(queue.head).to.equal(1);
            expect(queue.tail).to.equal(3);
            expect((await orderQueue.getOrder(1)).next).to.equal(3);
            expect((await orderQueue.getOrder(3)).prev).to.equal(1);
        });

        it("Should not reuse old order index after the old tail is canceled", async function () {
            await orderQueue.cancel(3);
            await orderQueue.append(addr1, 400, 9);
            expect(await orderQueue.lastReturn()).to.equal(4);
            const queue = await orderQueue.queue();
            expect(queue.tail).to.equal(4);
            expect(queue.counter).to.equal(4);
            expect((await orderQueue.getOrder(4)).prev).to.equal(2);
        });
    });

    describe("fill()", function () {
        it("Should delete the filled order", async function () {
            await orderQueue.fill(1);
            const order = await orderQueue.getOrder(1);
            expect(order.prev).to.equal(0);
            expect(order.next).to.equal(0);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.version).to.equal(0);
            expect(order.fillable).to.equal(0);
        });

        it("Should return the next index on fill", async function () {
            await orderQueue.fill(1);
            expect(await orderQueue.lastReturn()).to.equal(2);
            await orderQueue.fill(2);
            expect(await orderQueue.lastReturn()).to.equal(3);
        });

        it("Should return the next index on skip and fill", async function () {
            await orderQueue.fill(2);
            expect(await orderQueue.lastReturn()).to.equal(3);
        });

        it("Should return zero when the last order is filled", async function () {
            await orderQueue.fill(3);
            expect(await orderQueue.lastReturn()).to.equal(0);
        });
    });

    describe("updateHead()", function () {
        it("Should update links after filling one order", async function () {
            await orderQueue.fill(1);
            await orderQueue.updateHead(2);
            expect((await orderQueue.queue()).head).to.equal(2);
            expect((await orderQueue.getOrder(2)).prev).to.equal(0);
        });

        it("Should update links after skipping one order", async function () {
            await orderQueue.updateHead(2);
            expect((await orderQueue.queue()).head).to.equal(2);
            expect((await orderQueue.getOrder(2)).prev).to.equal(0);
        });

        it("Should update links after filling one and then skipping one", async function () {
            await orderQueue.fill(1);
            await orderQueue.updateHead(3);
            expect((await orderQueue.queue()).head).to.equal(3);
            expect((await orderQueue.getOrder(3)).prev).to.equal(0);
        });

        it("Should update links after skipping one and then filling one", async function () {
            await orderQueue.fill(2);
            await orderQueue.updateHead(3);
            expect((await orderQueue.queue()).head).to.equal(3);
            expect((await orderQueue.getOrder(3)).prev).to.equal(0);
        });

        it("Should update links after filling the last order", async function () {
            await orderQueue.fill(1);
            await orderQueue.fill(3);
            await orderQueue.updateHead(0);
            expect(await orderQueue.isEmpty()).to.equal(true);
            expect((await orderQueue.queue()).head).to.equal(0);
            expect((await orderQueue.queue()).tail).to.equal(0);
        });

        it("Should update links after skipping the last order", async function () {
            await orderQueue.fill(1);
            await orderQueue.fill(2);
            await orderQueue.updateHead(0);
            expect(await orderQueue.isEmpty()).to.equal(true);
            expect((await orderQueue.queue()).head).to.equal(0);
            expect((await orderQueue.queue()).tail).to.equal(0);
        });
    });

    describe("After matching", function () {
        it("Should not reuse old order index after a queue is completely filled", async function () {
            await orderQueue.fill(1);
            await orderQueue.fill(2);
            await orderQueue.fill(3);
            await orderQueue.updateHead(0);

            await orderQueue.append(addr1, 400, 9);
            expect(await orderQueue.lastReturn()).to.equal(4);
            await orderQueue.append(addr2, 500, 1);
            expect(await orderQueue.lastReturn()).to.equal(5);
            const queue = await orderQueue.queue();
            expect(queue.head).to.equal(4);
            expect(queue.tail).to.equal(5);
            expect(queue.counter).to.equal(5);
            expect((await orderQueue.getOrder(1)).prev).to.equal(0);
        });

        it("Should delete skipped order when canceling it", async function () {
            // The first two orders are skipped.
            await orderQueue.updateHead(3);
            await orderQueue.cancel(2);
            const order = await orderQueue.getOrder(2);
            expect(order.prev).to.equal(0);
            expect(order.next).to.equal(0);
            expect(order.maker).to.equal(ethers.constants.AddressZero);
            expect(order.amount).to.equal(0);
            expect(order.version).to.equal(0);
            expect(order.fillable).to.equal(0);
        });

        it("Should not update links when canceling an skipped order before head", async function () {
            // The first two orders are skipped.
            await orderQueue.updateHead(3);
            await orderQueue.cancel(2);
            expect((await orderQueue.queue()).head).to.equal(3);
            expect((await orderQueue.getOrder(3)).prev).to.equal(0);
            // Link in other skipped orders should not be updated, either.
            expect((await orderQueue.getOrder(1)).next).to.equal(2);
        });

        it("Should not update links when canceling an skipped previous-head order", async function () {
            // The first two orders are skipped.
            await orderQueue.updateHead(3);
            await orderQueue.cancel(1);
            expect((await orderQueue.queue()).head).to.equal(3);
            expect((await orderQueue.getOrder(3)).prev).to.equal(0);
            // Link in other skipped orders should not be updated, either.
            expect((await orderQueue.getOrder(2)).prev).to.equal(1);
        });
    });
});
