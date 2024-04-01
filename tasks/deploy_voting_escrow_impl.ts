import { task } from "hardhat/config";
import { GOVERNANCE_CONFIG } from "../config";
import { Addresses, loadAddressFile, newAddresses, saveAddressFile } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";
import { waitForContract } from "./utils";

export interface VotingEscrowImplAddresses extends Addresses {
    votingEscrowImpl: string;
}

task("deploy_voting_escrow_impl", "Deploy VotingEscrow implementation")
    .addOptionalParam("chess", "Chess contract address", "")
    .addOptionalParam("chessPool", "ProxyOFTPool contract address", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const chessAddress =
            args.chess || loadAddressFile<GovernanceAddresses>(hre, "governance").chess;
        const chessPoolAddress =
            args.chessPool || loadAddressFile<GovernanceAddresses>(hre, "governance").chessPool;

        const VotingEscrow = await ethers.getContractFactory("VotingEscrowV4");
        const votingEscrowImpl = await VotingEscrow.deploy(
            chessAddress,
            208 * 7 * 86400, // 208 weeks
            chessPoolAddress,
            GOVERNANCE_CONFIG.LZ_ENDPOINT
        );
        console.log(`VotingEscrow implementation: ${votingEscrowImpl.address}`);
        await waitForContract(hre, votingEscrowImpl.address);

        console.log("Making VotingEscrow implementation unusable without proxy");
        await (await votingEscrowImpl.initialize("", "", 0)).wait();
        await (await votingEscrowImpl.renounceOwnership()).wait();

        const addresses: VotingEscrowImplAddresses = {
            ...newAddresses(hre),
            votingEscrowImpl: votingEscrowImpl.address,
        };
        saveAddressFile(hre, "voting_escrow_v4_impl", addresses);
    });
