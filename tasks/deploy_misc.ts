import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { createAddressFile } from "./address_file";
import { updateHreSigner } from "./signers";

task("deploy_misc", "Deploy misc contracts interactively")
    .addFlag("silent", 'Assume "yes" as answer to all prompts and run non-interactively')
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;

        await hre.run("compile");
        const addressFile = createAddressFile(hre, "misc");

        if (args.silent || keyInYNStrict("Deploy ProtocolDataProvider?", { guide: true })) {
            const ProtocolDataProvider = await ethers.getContractFactory("ProtocolDataProvider");
            const protocolDataProvider = await ProtocolDataProvider.deploy();
            console.log(`ProtocolDataProvider: ${protocolDataProvider.address}`);
            addressFile.set("protocolDataProvider", protocolDataProvider.address);
        }
        if (args.silent || keyInYNStrict("Deploy BatchSettleHelper?", { guide: true })) {
            const BatchSettleHelper = await ethers.getContractFactory("BatchSettleHelper");
            const batchSettleHelper = await BatchSettleHelper.deploy();
            console.log(`BatchSettleHelper: ${batchSettleHelper.address}`);
            addressFile.set("batchSettleHelper", batchSettleHelper.address);
        }
    });
