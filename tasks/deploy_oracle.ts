import { task } from "hardhat/config";
import fs = require("fs");
import path = require("path");
import editJsonFile = require("edit-json-file");
import {
    COINBASE_ADDRESS,
    OKEX_ADDRESS,
    TEST_PRIMARY_SOURCE,
    TEST_SECONDARY_SOURCE,
    SYMBOLS,
} from "../config";

task("deploy", "Deploy contracts", async (_args, hre) => {
    const { ethers } = hre;

    const CONTRACT_ADDRESS_DIR = path.join(__dirname, "..", "cache");

    if (!fs.existsSync(CONTRACT_ADDRESS_DIR)) {
        fs.mkdirSync(CONTRACT_ADDRESS_DIR);
    }
    const contractAddress = editJsonFile(path.join(CONTRACT_ADDRESS_DIR, "contract_address.json"), {
        autosave: true,
    });

    await hre.run("compile");
    const TwapOracle = await ethers.getContractFactory("TwapOracle");
    let primarySource = COINBASE_ADDRESS;
    let secondarySource = OKEX_ADDRESS;
    if (hre.network.name === "test") {
        primarySource = TEST_PRIMARY_SOURCE;
        secondarySource = TEST_SECONDARY_SOURCE;
    }
    for (const symbol of SYMBOLS) {
        const contract = await TwapOracle.deploy(primarySource, secondarySource, symbol);
        contractAddress.set("twap_oracle_" + symbol, contract.address);
        console.log(`${symbol}: ${contract.address}`);
    }
});
