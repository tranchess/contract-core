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
    .addParam("chainId", "Sub chain ID")
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

        const chainId = parseInt(args.chainId);
        assert.ok(chainId > 0 && chainId < 1e9, "Invalid sub chain ID");
        const subSchedule = args.subSchedule;
        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const ChessScheduleRelayer = await ethers.getContractFactory("ChessScheduleRelayer");
        const relayer = await ChessScheduleRelayer.deploy(
            chainId,
            subSchedule,
            governanceAddresses.chessSchedule,
            governanceAddresses.chessController,
            governanceAddresses.anyswapChessPool,
            GOVERNANCE_CONFIG.ANY_CALL_PROXY
        );
        console.log(`ChessScheduleRelayer: ${relayer.address}`);

        const addresses: ChessScheduleRelayerAddresses = {
            ...newAddresses(hre),
            relayer: relayer.address,
        };
        saveAddressFile(hre, `chess_schedule_relayer_${chainId}`, addresses);
    });
