import { task } from "hardhat/config";
import { GOVERNANCE_CONFIG } from "../config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";

export interface ChessScheduleImplAddresses extends Addresses {
    chessScheduleImpl: string;
}

task("deploy_chess_schedule_impl", "Deploy ChessSchedule implementation")
    .addOptionalParam("chess", "Chess contract address", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const chessAddress =
            args.chess || loadAddressFile<GovernanceAddresses>(hre, "governance").chess;

        const ChessSchedule = await ethers.getContractFactory("ChessSchedule");
        const chessScheduleImpl = await ChessSchedule.deploy(
            chessAddress,
            GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP
        );
        console.log(`ChessSchedule implementation: ${chessScheduleImpl.address}`);

        const addresses: ChessScheduleImplAddresses = {
            ...newAddresses(hre),
            chessScheduleImpl: chessScheduleImpl.address,
        };
        saveAddressFile(hre, "chess_schedule_impl", addresses);
    });
