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
    votingEscrowHelper?: string;
}

task("deploy_misc", "Deploy misc contracts interactively")
    .addFlag("silent", "Run non-interactively and only deploy contracts specified by --deploy-*")
    .addFlag("deployProtocolDataProvider", "Deploy ProtocolDataProvider without prompt")
    .addFlag("deployBatchSettleHelper", "Deploy BatchSettleHelper without prompt")
    .addFlag("deployVotingEscrowHelper", "Deploy VotingEscrowHelper without prompt")
    .addOptionalParam("underlyingSymbol", "Symbol of the fund underlying", "")
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
            args.deployVotingEscrowHelper ||
            (!args.silent &&
                keyInYNStrict("Deploy VotingEscrowHelper implementation?", { guide: true }))
        ) {
            const underlyingSymbol: string = args.underlyingSymbol;
            assert.ok(underlyingSymbol.match(/[a-zA-Z]+/), "Invalid symbol");
            const fundAddresses = loadAddressFile<FundAddresses>(
                hre,
                `fund_${underlyingSymbol.toLowerCase()}`
            );
            const exchangeAddresses = loadAddressFile<ExchangeAddresses>(
                hre,
                `exchange_${underlyingSymbol.toLowerCase()}`
            );

            const VotingEscrowHelper = await ethers.getContractFactory("VotingEscrowHelper");
            const votingEscrowHelper = await VotingEscrowHelper.deploy(
                fundAddresses.feeDistributor,
                governanceAddresses.interestRateBallot,
                exchangeAddresses.exchange
            );
            console.log(`VotingEscrowHelper: ${votingEscrowHelper.address}`);
            addresses.votingEscrowHelper = votingEscrowHelper.address;
        }
        saveAddressFile(hre, "misc", addresses);
    });
