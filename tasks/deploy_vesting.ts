import { task } from "hardhat/config";
import { createAddressFile, selectAddressFile } from "./address_file";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

task("deploy_vesting", "Deploy and fund a VestingEscrow")
    .addOptionalParam("governance", "Path to the governance address file", "")
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
        const addressFile = createAddressFile(hre, "vesting");
        const governanceAddresses = await selectAddressFile(hre, "governance", args.governance);

        const chess = await ethers.getContractAt("Chess", governanceAddresses.chess);
        const amount = parseEther(args.amount);
        if (amount.gt(await chess.balanceOf(deployer.address))) {
            console.error("Insufficient CHESS in the deployer's account");
            return;
        }
        const recipient = getAddress(args.recipient);
        addressFile.set("recipient", recipient);
        const WEEK = 7 * 86400;
        const startTime = GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP + parseInt(args.startWeek) * WEEK;
        const endTime = startTime + parseInt(args.durationWeek) * WEEK;
        const cliffAmount = amount.mul(parseInt(args.cliffPercent)).div(100);

        const VestingEscrow = await ethers.getContractFactory("VestingEscrow");
        const vestingEscrow = await VestingEscrow.deploy(
            governanceAddresses.chess,
            recipient,
            startTime,
            endTime,
            true
        );
        console.log(`VestingEscrow: ${vestingEscrow.address}`);
        addressFile.set("vestingEscrow", vestingEscrow.address);

        console.log("Initializing the VestingEscrow");
        await chess.approve(vestingEscrow.address, amount);
        await vestingEscrow.initialize(amount, cliffAmount);
    });
