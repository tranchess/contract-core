import { task } from "hardhat/config";
import { endOfWeek } from "../config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { ControllerBallotAddresses } from "./deploy_controller_ballot";
import { updateHreSigner } from "./signers";
import { waitForContract } from "./utils";

export interface ChessControllerImplAddresses extends Addresses {
    chessControllerImpl: string;
}

task("deploy_chess_controller_impl", "Deploy ChessControllerV4 implementation")
    .addParam("launchDate", "Launch date (YYYY-MM-DD)")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const launchStart = endOfWeek(new Date(args.launchDate).getTime() / 1000);

        const controllerBallotAddress = loadAddressFile<ControllerBallotAddresses>(
            hre,
            "controller_ballot"
        ).controllerBallot;

        const ChessController = await ethers.getContractFactory("ChessControllerV6");
        const chessControllerImpl = await ChessController.deploy(
            ethers.constants.AddressZero,
            launchStart,
            controllerBallotAddress
        );
        console.log(`ChessController implementation: ${chessControllerImpl.address}`);
        await waitForContract(hre, chessControllerImpl.address);

        const addresses: ChessControllerImplAddresses = {
            ...newAddresses(hre),
            chessControllerImpl: chessControllerImpl.address,
        };
        saveAddressFile(hre, "chess_controller_v6_impl", addresses);
    });
