import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface VotingEscrowImplAddresses extends Addresses {
    votingEscrowImpl: string;
}

task("deploy_voting_escrow_impl", "Deploy VotingEscrow implementation")
    .addOptionalParam("chess", "Chess contract address", "")
    .addOptionalParam("anyswapChess", "AnyswapChess or AnyswapChessPool contract address", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const chessAddress =
            args.chess || loadAddressFile<GovernanceAddresses>(hre, "governance").chess;
        let anyswapChessAddress = args.anyswapChess;
        if (!anyswapChessAddress) {
            try {
                const chess = await ethers.getContractAt("AnyswapChessPool", chessAddress);
                assert.strictEqual(await chess.underlying(), ethers.constants.AddressZero);
                anyswapChessAddress = chess.address;
            } catch {
                anyswapChessAddress = loadAddressFile<GovernanceAddresses>(
                    hre,
                    "governance"
                ).anyswapChessPool;
            }
        }

        const VotingEscrow = await ethers.getContractFactory("VotingEscrowV3");
        const votingEscrowImpl = await VotingEscrow.deploy(
            chessAddress,
            208 * 7 * 86400, // 208 weeks
            anyswapChessAddress,
            GOVERNANCE_CONFIG.ANY_CALL_PROXY
        );
        console.log(`VotingEscrow implementation: ${votingEscrowImpl.address}`);

        console.log("Making VotingEscrow implementation unusable without proxy");
        await (await votingEscrowImpl.initialize("", "", 0)).wait();
        await votingEscrowImpl.renounceOwnership();

        const addresses: VotingEscrowImplAddresses = {
            ...newAddresses(hre),
            votingEscrowImpl: votingEscrowImpl.address,
        };
        saveAddressFile(hre, "voting_escrow_v3_impl", addresses);
    });
