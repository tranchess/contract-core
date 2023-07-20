import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface ChessScheduleRelayerAddresses extends Addresses {
    relayer: string;
}

task("deploy_chess_schedule_relayer", "Deploy ChessScheduleRelayer")
    .addFlag("dry", "Get contract address without deploying it")
    .addParam("lzChainId", "LayerZero sub chain ID")
    .addParam("subSchedule", "Address of ChessSubSchedule on the sub chain")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");
        const [deployer] = await ethers.getSigners();

        if (args.dry) {
            const addr = ethers.utils.getContractAddress({
                from: deployer.address,
                nonce: await deployer.getTransactionCount("pending"),
            });
            console.log(`ChessScheduleRelayer with be deployed at ${addr}`);
            return;
        }

        const lzChainId = parseInt(args.lzChainId);
        assert.ok(lzChainId > 0 && lzChainId < 1e9, "Invalid sub chain ID");
        const subSchedule = args.subSchedule;
        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const ChessScheduleRelayer = await ethers.getContractFactory("ChessScheduleRelayer");
        const relayer = await ChessScheduleRelayer.deploy(
            lzChainId,
            governanceAddresses.chessSchedule,
            governanceAddresses.chessController,
            governanceAddresses.chessPool,
            GOVERNANCE_CONFIG.LZ_ENDPOINT
        );
        console.log(`ChessScheduleRelayer: ${relayer.address}`);

        await relayer.setTrustedRemoteAddress(lzChainId, subSchedule);

        const addresses: ChessScheduleRelayerAddresses = {
            ...newAddresses(hre),
            relayer: relayer.address,
        };
        saveAddressFile(hre, `chess_schedule_relayer_${lzChainId}`, addresses);
    });
