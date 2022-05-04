import { BigNumberish, Wallet } from "ethers";
import { ethers } from "hardhat";

export const TRANCHE_Q = 0;
export const TRANCHE_B = 1;
export const TRANCHE_R = 2;
export const HOUR = 3600;
export const DAY = HOUR * 24;
export const WEEK = DAY * 7;
export const SETTLEMENT_TIME = HOUR * 14; // UTC time 14:00 every day

export interface FixtureWalletMap {
    readonly [name: string]: Wallet;
}

export async function advanceBlockAtTime(time: number): Promise<void> {
    await ethers.provider.send("evm_mine", [time]);
}

export async function setNextBlockTime(time: number): Promise<void> {
    await ethers.provider.send("evm_setNextBlockTimestamp", [time]);
}

/**
 * Note that failed transactions are silently ignored when automining is disabled.
 */
export async function setAutomine(flag: boolean): Promise<void> {
    await ethers.provider.send("evm_setAutomine", [flag]);
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Chai {
        // Fix type annotation in @ethereum-waffle/chai
        interface CloseTo {
            (expected: BigNumberish, delta: BigNumberish, message?: string): Assertion;
        }
    }
}
