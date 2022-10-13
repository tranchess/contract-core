import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";

export interface AnyswapChessPoolAddresses extends Addresses {
    anyswapChessPool: string;
}

task("deploy_anyswap_chess_pool", "Deploy AnyswapChessPool")
    .addOptionalParam("chess", "Chess contract address", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const chessAddress =
            args.chess || loadAddressFile<GovernanceAddresses>(hre, "governance").chess;

        const AnyswapChessPool = await ethers.getContractFactory("AnyswapChessPool");
        const anyswapChessPool = await AnyswapChessPool.deploy(
            "Anyswap Wrapped CHESS",
            "anyCHESS",
            chessAddress
        );
        console.log(`AnyswapChessPool: ${anyswapChessPool.address}`);

        const addresses: AnyswapChessPoolAddresses = {
            ...newAddresses(hre),
            anyswapChessPool: anyswapChessPool.address,
        };
        saveAddressFile(hre, `anyswap_chess_pool`, addresses);
    });
