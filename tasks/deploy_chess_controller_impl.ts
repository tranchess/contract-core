import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { endOfWeek } from "../config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { ControllerBallotAddresses } from "./deploy_controller_ballot";
import type { FundAddresses } from "./deploy_fund";
import { updateHreSigner } from "./signers";

export interface ChessControllerImplAddresses extends Addresses {
    chessControllerImpl: string;
}

task("deploy_chess_controller_impl", "Deploy ChessControllerV4 implementation")
    .addParam("firstUnderlyingSymbol", "Fund0 underlying symbols, or 'NONE'")
    .addParam("launchDate", "Launch date (YYYY-MM-DD)")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const fund0Symbol: string = args.firstUnderlyingSymbol;
        assert.match(fund0Symbol, /^[a-zA-Z]+|NONE$/, "Invalid symbol");
        const launchStart = endOfWeek(new Date(args.launchDate).getTime() / 1000);

        const controllerBallotAddress = loadAddressFile<ControllerBallotAddresses>(
            hre,
            "controller_ballot"
        ).controllerBallot;
        const fund0Address =
            fund0Symbol === "NONE"
                ? ethers.constants.AddressZero
                : loadAddressFile<FundAddresses>(hre, `fund_${fund0Symbol.toLowerCase()}`).fund;

        const ChessController = await ethers.getContractFactory("ChessControllerV5");
        const chessControllerImpl = await ChessController.deploy(
            fund0Address,
            launchStart,
            controllerBallotAddress
        );
        console.log(`ChessController implementation: ${chessControllerImpl.address}`);

        const addresses: ChessControllerImplAddresses = {
            ...newAddresses(hre),
            chessControllerImpl: chessControllerImpl.address,
        };
        saveAddressFile(hre, "chess_controller_v5_impl", addresses);
    });
