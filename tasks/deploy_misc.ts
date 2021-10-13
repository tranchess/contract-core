import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { FundAddresses } from "./deploy_fund";
import type { ExchangeAddresses } from "./deploy_exchange";
import { updateHreSigner } from "./signers";

export interface MiscAddresses extends Addresses {
    protocolDataProvier?: string;
    batchSettleHelper?: string;
    batchOperationHelper?: string;
    votingEscrowHelper?: string;
}

task("deploy_misc", "Deploy misc contracts interactively")
    .addFlag("silent", "Run non-interactively and only deploy contracts specified by --deploy-*")
    .addFlag("deployProtocolDataProvider", "Deploy ProtocolDataProvider without prompt")
    .addFlag("deployBatchSettleHelper", "Deploy BatchSettleHelper without prompt")
    .addFlag("deployBatchOperationHelper", "Deploy BatchOperationHelper without prompt")
    .addFlag("deployVotingEscrowHelper", "Deploy VotingEscrowHelper without prompt")
    .addOptionalParam("underlyingSymbols", "Comma-separated fund underlying symbols", "")
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
            const protocolDataProvider = await ProtocolDataProvider.deploy();
            console.log(`ProtocolDataProvider: ${protocolDataProvider.address}`);
            addresses.protocolDataProvier = protocolDataProvider.address;
        }
        if (
            args.deployBatchSettleHelper ||
            (!args.silent &&
                keyInYNStrict("Deploy BatchSettleHelper implementation?", { guide: true }))
        ) {
            const BatchSettleHelper = await ethers.getContractFactory("BatchSettleHelper");
            const batchSettleHelper = await BatchSettleHelper.deploy();
            console.log(`BatchSettleHelper: ${batchSettleHelper.address}`);
            addresses.batchSettleHelper = batchSettleHelper.address;
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
            args.deployVotingEscrowHelper ||
            (!args.silent &&
                keyInYNStrict("Deploy VotingEscrowHelper implementation?", { guide: true }))
        ) {
            const symbols: string[] = args.underlyingSymbols.split(",");
            assert.strictEqual(symbols.length, 2);
            assert.ok(symbols[0].match(/[a-zA-Z]+/), "Invalid symbol");
            assert.ok(symbols[1].match(/[a-zA-Z]+/), "Invalid symbol");
            const fund0Addresses = loadAddressFile<FundAddresses>(
                hre,
                `fund_${symbols[0].toLowerCase()}`
            );
            const exchange0Addresses = loadAddressFile<ExchangeAddresses>(
                hre,
                `exchange_${symbols[0].toLowerCase()}`
            );
            const fund1Addresses = loadAddressFile<FundAddresses>(
                hre,
                `fund_${symbols[1].toLowerCase()}`
            );
            const exchange1Addresses = loadAddressFile<ExchangeAddresses>(
                hre,
                `exchange_${symbols[1].toLowerCase()}`
            );

            const VotingEscrowHelper = await ethers.getContractFactory("VotingEscrowHelper");
            const votingEscrowHelper = await VotingEscrowHelper.deploy(
                governanceAddresses.interestRateBallot,
                fund0Addresses.feeDistributor,
                exchange0Addresses.exchange,
                fund1Addresses.feeDistributor,
                exchange1Addresses.exchange
            );
            console.log(`VotingEscrowHelper: ${votingEscrowHelper.address}`);
            addresses.votingEscrowHelper = votingEscrowHelper.address;
        }
        saveAddressFile(hre, "misc", addresses);
    });
