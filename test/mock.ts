import { expect, Assertion } from "chai";
import { ethers, waffle } from "hardhat";
import type { MockContract, Stub } from "ethereum-waffle";
import type { Signer, Transaction } from "ethers";
const { deployMockContract } = waffle;

export async function deployMockForName(deployer: Signer, name: string): Promise<MockContract> {
    const Contract = await ethers.getContractAt(name, ethers.constants.AddressZero);
    return await deployMockContract(deployer, Contract.interface.format() as string[]);
}

export interface MockCall {
    func: Stub;
    rets?: unknown[];
}

Assertion.addMethod("callMocks", async function (...calls: MockCall[]): Promise<Transaction> {
    const txBuilder = this._obj;
    // Initialize each mock call to revert with a special reason
    const reason = (i: number) =>
        `Mock func ${i + 1}/${calls.length} is called` +
        " <Use 'callMocksDebug' instead of 'callMocks' to debug if you see this message>";
    for (let i = 0; i < calls.length; i++) {
        const { func } = calls[i];
        await func.revertsWithReason(reason(i));
    }
    // Expect the transaction reverts on each mock call one by one
    for (let i = 0; i < calls.length; i++) {
        const { func, rets } = calls[i];
        await expect(txBuilder()).to.be.revertedWith(reason(i));
        if (rets === undefined) {
            await func.returns();
        } else {
            await func.returns(...rets);
        }
    }
    // Run the transaction normally
    const tx = await txBuilder();
    // Reset mock functions
    for (const { func } of calls) {
        await func.revertsWithReason("Mock on the method is not initialized");
    }
    return tx;
});

Assertion.addMethod("callMocksDebug", async function (...calls: MockCall[]): Promise<Transaction> {
    const txBuilder = this._obj;
    // Initialize each mock call to revert with a special reason
    const reason = (i: number) => `Mock func ${i + 1}/${calls.length} is called`;
    for (let i = 0; i < calls.length; i++) {
        const { func } = calls[i];
        await func.revertsWithReason(reason(i));
    }
    // Expect the transaction reverts on each mock call one by one
    for (let i = 0; i < calls.length; i++) {
        const { func, rets } = calls[i];
        try {
            await expect(txBuilder()).to.be.revertedWith(reason(i));
        } catch (e) {
            console.trace(`Mock function ${i + 1}/${calls.length} is not called as expected`);
            await txBuilder();
            throw new Error(
                "The transaction succeeds while some mock function is not called as expected"
            );
        }
        if (rets === undefined) {
            await func.returns();
        } else {
            await func.returns(...rets);
        }
    }
    // Run the transaction normally
    const tx = await txBuilder();
    // Reset mock functions
    for (const { func } of calls) {
        await func.revertsWithReason("Mock on the method is not initialized");
    }
    console.warn(
        "WARNING: 'callMocksDebug' is only for debugging. Use 'callMocks' instead after you make things right."
    );
    return tx;
});

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Chai {
        interface Assertion {
            /**
             * Expect the mock functions are called by the transaction in the specified order.
             *
             * For each mock function, this assertion sets it to revert with a special message
             * and expects to get the message when executing the transaction. This assertion is
             * very slow due to the large number of executed transactions.
             *
             * The transaction call should be passed to the `expect` as a callback,
             * because it will be executed and expected to revert multiple times.
             *
             * This assertion cannot be negated by `not`.
             *
             * @param {...MockCall} calls An Object describing an expected call.
             * @param calls[].func Expected mock function.
             * @param calls[].rets A list of return values.
             * @returns {Promise<Transaction>} The executed transaction.
             */
            callMocks(...calls: MockCall[]): Promise<Transaction>;

            /**
             * A replacement of `callMocks` that outputs debug information when the assertion fails.
             */
            callMocksDebug(...calls: MockCall[]): Promise<Transaction>;
        }
    }
}
