import { ethers } from "hardhat";
import { BigNumber } from "ethers";
const { parseEther } = ethers.utils;

export const REWARD_WEIGHT_M = 3;
export const REWARD_WEIGHT_A = 4;
export const REWARD_WEIGHT_B = 2;
export const MAX_BOOSTING_FACTOR = parseEther("3");

export function boostedWorkingBalance(
    amountM: BigNumber,
    amountA: BigNumber,
    amountB: BigNumber,
    weightedSupply: BigNumber,
    veProportion: BigNumber
): BigNumber {
    const e18 = parseEther("1");
    const weightedAB = amountA
        .mul(REWARD_WEIGHT_A)
        .add(amountB.mul(REWARD_WEIGHT_B))
        .div(REWARD_WEIGHT_M);
    const upperBoundAB = weightedAB.mul(MAX_BOOSTING_FACTOR).div(e18);
    let workingAB = weightedAB.add(
        weightedSupply.mul(veProportion).div(e18).mul(MAX_BOOSTING_FACTOR.sub(e18)).div(e18)
    );
    let workingM = amountM;
    if (upperBoundAB.lte(workingAB)) {
        const excessiveBoosting = workingAB
            .sub(upperBoundAB)
            .mul(e18)
            .div(MAX_BOOSTING_FACTOR.sub(e18));
        workingAB = upperBoundAB;
        const upperBoundBoostingPowerM = weightedSupply.mul(veProportion).div(e18).div(2);
        const boostingPowerM = excessiveBoosting.lte(upperBoundBoostingPowerM)
            ? excessiveBoosting
            : upperBoundBoostingPowerM;
        workingM = amountM.add(boostingPowerM.mul(MAX_BOOSTING_FACTOR.sub(e18)).div(e18));
        const upperBoundM = amountM.mul(MAX_BOOSTING_FACTOR);
        workingM = workingM.lte(upperBoundM) ? workingM : upperBoundM;
    }
    return workingAB.add(workingM);
}
