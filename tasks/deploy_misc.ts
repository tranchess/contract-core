import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { Addresses, saveAddressFile, newAddresses, loadAddressFile } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";

export interface MiscAddresses extends Addresses {
    protocolDataProvier?: string;
    batchOperationHelper?: string;
    batchUpgradeTool?: string;
}

task("deploy_misc", "Deploy misc contracts interactively")
    .addFlag("silent", "Run non-interactively and only deploy contracts specified by --deploy-*")
    .addFlag("deployProtocolDataProvider", "Deploy ProtocolDataProvider without prompt")
    .addFlag("deployBatchOperationHelper", "Deploy BatchOperationHelper without prompt")
    .addFlag("deployBatchUpgradeTool", "Deploy BatchUpgradeTool without prompt")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const addresses: MiscAddresses = newAddresses(hre);
        if (
            args.deployProtocolDataProvider ||
            (!args.silent &&
                keyInYNStrict("Deploy ProtocolDataProvider implementation?", { guide: true }))
        ) {
            const ProtocolDataProvider = await ethers.getContractFactory("ProtocolDataProvider");
            const protocolDataProvider = await ProtocolDataProvider.deploy(
                governanceAddresses.votingEscrow,
                governanceAddresses.chessSchedule,
                governanceAddresses.controllerBallot,
                governanceAddresses.interestRateBallot
            );
            console.log(`ProtocolDataProvider: ${protocolDataProvider.address}`);
            addresses.protocolDataProvier = protocolDataProvider.address;
        }
        if (
            args.deployBatchOperationHelper ||
            (!args.silent &&
                keyInYNStrict("Deploy BatchOperationHelper implementation?", { guide: true }))
        ) {
            const BatchOperationHelper = await ethers.getContractFactory("BatchOperationHelper");
            const batchOperationHelper = await BatchOperationHelper.deploy();
            console.log(`BatchOperationHelper: ${batchOperationHelper.address}`);
            addresses.batchOperationHelper = batchOperationHelper.address;
        }
        if (
            args.deployBatchUpgradeTool ||
            (!args.silent &&
                keyInYNStrict("Deploy BatchUpgradeTool implementation?", { guide: true }))
        ) {
            const BatchUpgradeTool = await ethers.getContractFactory("BatchUpgradeTool");
            const batchUpgradeTool = await BatchUpgradeTool.deploy();
            console.log(`BatchUpgradeTool: ${batchUpgradeTool.address}`);
            addresses.batchUpgradeTool = batchUpgradeTool.address;
        }
        saveAddressFile(hre, "misc", addresses);
    });
