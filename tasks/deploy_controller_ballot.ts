import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { FundAddresses } from "./deploy_fund";
import { updateHreSigner } from "./signers";

export interface ControllerBallotAddresses extends Addresses {
    controllerBallot: string;
}

task("deploy_controller_ballot", "Deploy ControllerBallot")
    .addOptionalParam("votingEscrow", "VotingEscrow contract address", "")
    .addOptionalParam("underlyingSymbols", "Comma-separated fund underlying symbols", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        let votingEscrowAddress = args.votingEscrow;
        let timelockControllerAddress;
        if (!votingEscrowAddress) {
            const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
            votingEscrowAddress = governanceAddresses.votingEscrow;
            timelockControllerAddress = governanceAddresses.timelockController;
        }
        const symbols: string[] = args.underlyingSymbols.split(",").filter(Boolean);
        for (const symbol of symbols) {
            assert.match(symbol, /^[a-zA-Z]+$/, "Invalid symbol");
        }

        const ControllerBallot = await ethers.getContractFactory("ControllerBallot");
        const controllerBallot = await ControllerBallot.deploy(votingEscrowAddress);
        console.log(`ControllerBallot: ${controllerBallot.address}`);

        for (const symbol of symbols) {
            console.log(`Adding ${symbol} fund`);
            const fundAddresses = loadAddressFile<FundAddresses>(
                hre,
                `fund_${symbol.toLowerCase()}`
            );
            await controllerBallot.addPool(fundAddresses.fund);
        }

        if (timelockControllerAddress) {
            console.log("Transfering ownership to TimelockController");
            await controllerBallot.transferOwnership(timelockControllerAddress);
        } else {
            console.log("NOTE: Please transfer ownership of ControllerBallot to Timelock later");
        }

        const addresses: ControllerBallotAddresses = {
            ...newAddresses(hre),
            controllerBallot: controllerBallot.address,
        };
        saveAddressFile(hre, "controller_ballot", addresses);
    });
