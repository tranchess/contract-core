import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { Addresses, saveAddressFile, newAddresses } from "./address_file";
import { updateHreSigner } from "./signers";

export interface MiscAddresses extends Addresses {
    protocolDataProvier?: string;
    batchOperationHelper?: string;
    batchUpgradeTool?: string;
}

task("deploy_misc", "Deploy misc contracts interactively")
    .addFlag("silent", "Run non-interactively and only deploy contracts specified by --deploy-*")
    .addFlag("deployBatchOperationHelper", "Deploy BatchOperationHelper without prompt")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const addresses: MiscAddresses = newAddresses(hre);
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
        saveAddressFile(hre, "misc", addresses);
    });
