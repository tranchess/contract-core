import { task } from "hardhat/config";
import { Addresses, saveAddressFile, newAddresses } from "./address_file";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface StrategyAddresses extends Addresses {
    strategy: string;
}

task("deploy_bsc_staking_strategy", "Deploy BscStakingStrategy")
    .addParam("fund", "Fund contract address")
    .addParam("staker", "Staker address")
    .addParam("performanceFeeRate", "Performance fee rate")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const performanceFeeRate = parseEther(args.performanceFeeRate);

        const BscStakingStrategy = await ethers.getContractFactory("BscStakingStrategy");
        const bscStakingStrategy = await BscStakingStrategy.deploy(
            args.fund,
            args.staker,
            performanceFeeRate
        );
        console.log(`BscStakingStrategy: ${bscStakingStrategy.address}`);

        if (GOVERNANCE_CONFIG.TREASURY) {
            console.log("Transfering ownership to treasury");
            await bscStakingStrategy.transferOwnership(GOVERNANCE_CONFIG.TREASURY);
        }

        const addresses: StrategyAddresses = {
            ...newAddresses(hre),
            strategy: bscStakingStrategy.address,
        };
        saveAddressFile(hre, "bsc_staking_strategy", addresses);
    });
