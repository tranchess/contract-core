import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";

export interface VotingEscrowImplAddresses extends Addresses {
    votingEscrowImpl: string;
}

task("deploy_voting_escrow_impl", "Deploy VotingEscrow implementation")
    .addOptionalParam("chess", "Chess contract address", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const chessAddress =
            args.chess || loadAddressFile<GovernanceAddresses>(hre, "governance").chess;

        const VotingEscrow = await ethers.getContractFactory("VotingEscrowV2");
        const votingEscrowImpl = await VotingEscrow.deploy(
            chessAddress,
            208 * 7 * 86400 // 208 weeks
        );
        console.log(`VotingEscrow implementation: ${votingEscrowImpl.address}`);

        console.log("Making VotingEscrow implementation unusable without proxy");
        await (await votingEscrowImpl.initialize("", "", 0)).wait();
        await votingEscrowImpl.renounceOwnership();

        const addresses: VotingEscrowImplAddresses = {
            ...newAddresses(hre),
            votingEscrowImpl: votingEscrowImpl.address,
        };
        saveAddressFile(hre, "voting_escrow_v2_impl", addresses);
    });
