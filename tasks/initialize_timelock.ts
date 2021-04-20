import { task } from "hardhat/config";
import fs = require("fs");

task("initialize_timelock", "Initialize timelock")
    .addParam(
        "deploy",
        "Path to the JSON file created by the deploy task, usually in the 'cache' directory"
    )
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const addresses = JSON.parse(fs.readFileSync(args.deploy, "utf-8"));

        const fund = await ethers.getContractAt("Fund", addresses.fund);
        const chess = await ethers.getContractAt("Chess", addresses.chess);
        const timelock = await ethers.getContractAt("Timelock", addresses.timelock);

        console.log("Conveying centralized ownerships to Timelock");
        await fund.transferOwnership(addresses.timelock);
        await chess.transferOwnership(addresses.timelock);

        console.log("Renouncing centralized admin role in Timelock");
        await timelock.renounceAdmin();
    });
