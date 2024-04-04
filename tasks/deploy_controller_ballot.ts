import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { FundAddresses } from "./deploy_fund";
import type { StableSwapAddresses } from "./deploy_stable_swap";
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

        const ControllerBallot = await ethers.getContractFactory("ControllerBallotV2");
        const controllerBallot = await ControllerBallot.deploy(votingEscrowAddress);
        console.log(`ControllerBallot: ${controllerBallot.address}`);

        for (const symbol of symbols) {
            const fundAddresses = loadAddressFile<FundAddresses>(
                hre,
                `fund_${symbol.toLowerCase()}`
            );
            if (fundAddresses.shareStaking) {
                console.log(`Adding ${symbol} staking`);
                await controllerBallot.addPool(fundAddresses.shareStaking);
            }
            console.log(`Adding ${symbol} BISHOP stable swap's liquidity gauge`);
            const stableSwapAddresses = loadAddressFile<StableSwapAddresses>(
                hre,
                `bishop_stable_swap_${symbol.toLowerCase()}`
            );
            await controllerBallot.addPool(stableSwapAddresses.liquidityGauge);
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
