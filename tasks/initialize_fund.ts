import { task } from "hardhat/config";
import fs = require("fs");

task("initialize_fund", "Initialize fund")
    .addParam(
        "deploy",
        "Path to the JSON file created by the deploy task, usually in the 'cache' directory"
    )
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const addresses = JSON.parse(fs.readFileSync(args.deploy, "utf-8"));

        const [deployer] = await ethers.getSigners();
        const fund = await ethers.getContractAt("Fund", addresses.fund);
        const btc = await ethers.getContractAt("MockToken", addresses.btc);
        const btcDecimals = await btc.decimals();

        console.log("Initializing Fund");
        await fund.initialize(
            addresses.btc,
            btcDecimals,
            addresses.share_p,
            addresses.share_a,
            addresses.share_b,
            addresses.apr_oracle,
            addresses.interest_rate_ballot,
            addresses.primary_market,
            deployer.address // FIXME read from configuration
        );
    });
