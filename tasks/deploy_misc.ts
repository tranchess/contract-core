import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { createAddressFile, selectAddressFile } from "./address_file";
import { updateHreSigner } from "./signers";

task("deploy_misc", "Deploy misc contracts interactively")
    .addOptionalParam("governance", "Path to the governance address file", "")
    .addOptionalParam("exchange", "Path to the exchange address file", "")
    .addOptionalParam("feeDistributor", "Path to the fee distributor address file", "")
    .addFlag("silent", 'Assume "yes" as answer to all prompts and run non-interactively')
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;

        await hre.run("compile");
        const addressFile = createAddressFile(hre, "misc");
        const governanceAddresses = await selectAddressFile(hre, "governance", args.governance);
        const exchangeAddresses = await selectAddressFile(hre, "exchange", args.exchange);
        const feeDistributorAddresses = await selectAddressFile(
            hre,
            "fee_distributor",
            args.exchange
        );

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
        if (args.silent || keyInYNStrict("Deploy VotingEscrowHelper?", { guide: true })) {
            const VotingEscrowHelper = await ethers.getContractFactory("VotingEscrowHelper");
            const votingEscrowHelper = await VotingEscrowHelper.deploy(
                feeDistributorAddresses.feeDistributor,
                governanceAddresses.interestRateBallot,
                exchangeAddresses.exchange
            );
            console.log(`VotingEscrowHelper: ${votingEscrowHelper.address}`);
            addressFile.set("votingEscrowHelper", votingEscrowHelper.address);
        }
    });
