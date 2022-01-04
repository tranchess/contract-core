import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { endOfWeek } from "../config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { FundAddresses } from "./deploy_fund";
import { updateHreSigner } from "./signers";

export interface ChessControllerImplAddresses extends Addresses {
    chessControllerImpl: string;
}

task("deploy_chess_controller_impl", "Deploy ChessControllerV3 implementation")
    .addParam("underlyingSymbols", "Comma-separated fund underlying symbols")
    .addParam("launchDateV2", "Launch date (YYYY-MM-DD)")
    .addParam("launchDateV3", "Launch date (YYYY-MM-DD)")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const symbols: string[] = args.underlyingSymbols.split(",");
        assert.strictEqual(symbols.length, 3);
        assert.match(symbols[0], /^[a-zA-Z]+$/, "Invalid symbol");
        assert.match(symbols[1], /^[a-zA-Z]+$/, "Invalid symbol");
        assert.match(symbols[2], /^[a-zA-Z]+$/, "Invalid symbol");
        const launchStartV2 = endOfWeek(new Date(args.launchDateV2).getTime() / 1000);
        const launchStartV3 = endOfWeek(new Date(args.launchDateV3).getTime() / 1000);

        const fund0Addresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${symbols[0].toLowerCase()}`
        );
        const fund1Addresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${symbols[1].toLowerCase()}`
        );
        const fund2Addresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${symbols[2].toLowerCase()}`
        );

        const ChessController = await ethers.getContractFactory("ChessControllerV3");
        const chessControllerImpl = await ChessController.deploy(
            fund0Addresses.fund,
            fund1Addresses.fund,
            fund2Addresses.fund,
            launchStartV2,
            launchStartV3,
            parseEther("0.01") // minWeight
        );
        console.log(`ChessController implementation: ${chessControllerImpl.address}`);

        const addresses: ChessControllerImplAddresses = {
            ...newAddresses(hre),
            chessControllerImpl: chessControllerImpl.address,
        };
        saveAddressFile(hre, "chess_controller_v3_impl", addresses);
    });
