import { task } from "hardhat/config";
import { Addresses, saveAddressFile, newAddresses, loadAddressFile } from "./address_file";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";
import { GovernanceAddresses } from "./deploy_governance";

export interface StrategyAddresses extends Addresses {
    strategy: string;
}

const STAKE_HUB_ADDR = "0x0000000000000000000000000000000000002002";

task("deploy_bsc_staking_strategy", "Deploy BscStakingStrategy")
    .addParam("fund", "Fund contract address")
    .addParam("performanceFeeRate", "Performance fee rate")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const performanceFeeRate = parseEther(args.performanceFeeRate);
        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const BscStakingStrategy = await ethers.getContractFactory("BscStakingStrategyV2");
        const bscStakingStrategyImpl = await BscStakingStrategy.deploy(STAKE_HUB_ADDR, args.fund);
        console.log(`BscStakingStrategy implementation: ${bscStakingStrategyImpl.address}`);

        const initTx = await bscStakingStrategyImpl.populateTransaction.initialize(
            performanceFeeRate
        );
        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const bscStakingStrategyProxy = await TransparentUpgradeableProxy.deploy(
            bscStakingStrategyImpl.address,
            governanceAddresses.proxyAdmin,
            initTx.data,
            { gasLimit: 1e6 } // Gas estimation may fail
        );
        const bscStakingStrategy = BscStakingStrategy.attach(bscStakingStrategyProxy.address);
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
