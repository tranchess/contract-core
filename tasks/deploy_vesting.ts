import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface VestingAddresses extends Addresses {
    recipient: string;
    vestingEscrow: string;
}

task("deploy_vesting", "Deploy and fund a VestingEscrow")
    .addParam("amount", "Amount of locked tokens")
    .addParam("recipient", "Recipient of the tokens")
    .addParam("startWeek", "Locked time in weeks before the first token is vested")
    .addParam("durationWeek", "Locked time in weeks from the first token is vested to all vested")
    .addParam("cliffPercent", "Pencentage of tokens vested immediately at the beginning")
    .setAction(async (args, hre) => {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther, getAddress } = ethers.utils;
        await hre.run("compile");
        const [deployer] = await ethers.getSigners();

        const amount = parseEther(args.amount);
        const recipient = getAddress(args.recipient);
        const WEEK = 7 * 86400;
        const startTime = GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP + parseInt(args.startWeek) * WEEK;
        const endTime = startTime + parseInt(args.durationWeek) * WEEK;
        const cliffAmount = amount.mul(parseInt(args.cliffPercent)).div(100);

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const chess = await ethers.getContractAt("Chess", governanceAddresses.chess);
        assert.ok(
            amount.lte(await chess.balanceOf(deployer.address)),
            "Insufficient CHESS in the deployer's account"
        );

        const VestingEscrow = await ethers.getContractFactory("VestingEscrow");
        const vestingEscrow = await VestingEscrow.deploy(
            governanceAddresses.chess,
            recipient,
            startTime,
            endTime,
            true
        );
        console.log(`VestingEscrow: ${vestingEscrow.address}`);

        console.log("Initializing the VestingEscrow");
        await (await chess.approve(vestingEscrow.address, amount)).wait();
        await vestingEscrow.initialize(amount, cliffAmount);

        const addresses: VestingAddresses = {
            ...newAddresses(hre),
            recipient,
            vestingEscrow: vestingEscrow.address,
        };
        saveAddressFile(hre, "vesting", addresses);
    });
