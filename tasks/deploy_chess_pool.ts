import { task } from "hardhat/config";
import { GOVERNANCE_CONFIG } from "../config";
import { Addresses, loadAddressFile, newAddresses, saveAddressFile } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";
import { waitForContract } from "./utils";

export interface ChessPoolAddresses extends Addresses {
    chessPool: string;
}

task("deploy_chess_pool", "Deploy LzChessPool")
    .addOptionalParam("chess", "Chess contract address", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const chessAddress =
            args.chess || loadAddressFile<GovernanceAddresses>(hre, "governance").chess;

        const ChessPool = await ethers.getContractFactory("ProxyOFTPool");
        const chessPool = await ChessPool.deploy(GOVERNANCE_CONFIG.LZ_ENDPOINT, chessAddress);
        console.log(`ChessPool: ${chessPool.address}`);
        await waitForContract(hre, chessPool.address);

        await (await chessPool.setUseCustomAdapterParams(true)).wait();

        const addresses: ChessPoolAddresses = {
            ...newAddresses(hre),
            chessPool: chessPool.address,
        };
        saveAddressFile(hre, `chess_pool`, addresses);
    });
