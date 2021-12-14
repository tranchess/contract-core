import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { endOfWeek } from "../config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { FundAddresses } from "./deploy_fund";
import { updateHreSigner } from "./signers";

export interface ChessControllerImplAddresses extends Addresses {
    chessControllerImpl: string;
}

task("deploy_chess_controller_impl", "Deploy ChessController implementation")
    .addParam("underlyingSymbols", "Comma-separated fund underlying symbols")
    .addParam("launchDate", "Launch date (YYYY-MM-DD)")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const symbols: string[] = args.underlyingSymbols.split(",");
        assert.strictEqual(symbols.length, 2);
        assert.match(symbols[0], /^[a-zA-Z]+$/, "Invalid symbol");
        assert.match(symbols[1], /^[a-zA-Z]+$/, "Invalid symbol");
        const launchStart = endOfWeek(new Date(args.launchDate).getTime() / 1000);

        const fund0Addresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${symbols[0].toLowerCase()}`
        );
        const fund1Addresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${symbols[1].toLowerCase()}`
        );

        const ChessController = await ethers.getContractFactory("ChessControllerV2");
        const chessControllerImpl = await ChessController.deploy(
            fund0Addresses.fund,
            fund1Addresses.fund,
            launchStart,
            parseEther("0.01") // minWeight
        );
        console.log(`ChessController implementation: ${chessControllerImpl.address}`);

        const addresses: ChessControllerImplAddresses = {
            ...newAddresses(hre),
            chessControllerImpl: chessControllerImpl.address,
        };
        saveAddressFile(hre, "chess_controller_v2_impl", addresses);
    });
