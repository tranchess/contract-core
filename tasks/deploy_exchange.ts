import { task } from "hardhat/config";
import fs = require("fs");
import path = require("path");
import { execSync } from "child_process";
import editJsonFile = require("edit-json-file");
import {
    TEST_FUND,
    TEST_CHESS,
    TEST_USDC,
    TEST_VOTING_ESCROW,
    TEST_MIN_ORDER_AMOUNT,
    TEST_MAKER_REQUIREMENT,
    STAGING_FUND,
    STAGING_CHESS,
    STAGING_USDC,
    STAGING_VOTING_ESCROW,
    STAGING_MIN_ORDER_AMOUNT,
    STAGING_MAKER_REQUIREMENT,
} from "../config";

function getAddressFilename(network: string) {
    const now = new Date();
    let s = now.toISOString();
    s = s.split(".")[0];
    s = s.replace("T", "_");
    s = s.split("-").join("");
    s = s.split(":").join("");
    return `deploy_${network}_${s}.json`;
}

task("deploy", "Deploy contracts", async (_args, hre) => {
    const { ethers } = hre;
    const { parseEther, parseUnits } = ethers.utils;

    const ADDRESS_FILE_LOCATION = path.join(__dirname, "..", "cache");
    if (!fs.existsSync(ADDRESS_FILE_LOCATION)) {
        fs.mkdirSync(ADDRESS_FILE_LOCATION);
    }
    const addressFilename = path.join(ADDRESS_FILE_LOCATION, getAddressFilename(hre.network.name));
    const addressFile = editJsonFile(addressFilename, {
        autosave: true,
    });
    const [deployer] = await ethers.getSigners();

    await hre.run("compile");

    let gitVersion;
    try {
        gitVersion = execSync("git rev-parse HEAD").toString().trim();
    } catch (e) {
        gitVersion = "N/A";
    }
    addressFile.set("git_version", gitVersion);
    addressFile.set("time", new Date().toJSON());

    let fundAddress;
    let chessAddress;
    let usdcAddress;
    let votingEscrowAddress;
    let minOrderAmount;
    let makerRequirement;
    if (hre.network.name === "test" || hre.network.name === "hardhat") {
        fundAddress = TEST_FUND;
        chessAddress = TEST_CHESS;
        usdcAddress = TEST_USDC;
        votingEscrowAddress = TEST_VOTING_ESCROW;
        minOrderAmount = TEST_MIN_ORDER_AMOUNT;
        makerRequirement = TEST_MAKER_REQUIREMENT;
    } else if (hre.network.name === "staging") {
        fundAddress = STAGING_FUND;
        chessAddress = STAGING_CHESS;
        usdcAddress = STAGING_USDC;
        votingEscrowAddress = STAGING_VOTING_ESCROW;
        minOrderAmount = STAGING_MIN_ORDER_AMOUNT;
        makerRequirement = STAGING_MAKER_REQUIREMENT;
    } else {
        console.error("ERROR: Unknown hardhat network:", hre.network.name);
        return;
    }

    const usdc = await ethers.getContractAt("ERC20", usdcAddress);
    const usdcDecimals = await usdc.decimals();

    const ChessController = await ethers.getContractFactory("ChessController");
    const chessController = await ChessController.deploy();
    addressFile.set("chess_controller", chessController.address);
    console.log("ChessController:", chessController.address);

    const Exchange = await ethers.getContractFactory("Exchange");
    const exchangeImpl = await Exchange.deploy(
        fundAddress,
        chessAddress,
        chessController.address,
        usdcAddress,
        usdcDecimals,
        votingEscrowAddress,
        parseUnits(minOrderAmount, usdcDecimals),
        parseEther(minOrderAmount),
        parseEther(makerRequirement)
    );
    addressFile.set("exchange_impl", exchangeImpl.address);
    console.log("Exchange implementation:", exchangeImpl.address);

    const TranchessProxy = await ethers.getContractFactory("TranchessProxy");
    const exchangeProxy = await TranchessProxy.deploy(
        exchangeImpl.address,
        deployer.address,
        "0x",
        { gasLimit: 1e6 } // Gas estimation may fail
    );
    const exchange = Exchange.attach(exchangeProxy.address);
    addressFile.set("exchange", exchange.address);
    console.log("Exchange:", exchange.address);

    const chess = await ethers.getContractAt("IChess", chessAddress);
    await chess.addMinter(exchange.address);
    console.log("Exchange is a CHESS minter now");

    const AccountData = await ethers.getContractFactory("AccountData");
    const accountData = await AccountData.deploy();
    addressFile.set("account_data", accountData.address);
    console.log("AccountData:", accountData.address);
});
