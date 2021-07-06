import { task } from "hardhat/config";
import { selectAddressFile } from "./address_file";
import {
    endOfWeek,
    APR_ORACLE_CONFIG,
    GOVERNANCE_CONFIG,
    FUND_CONFIG,
    EXCHANGE_CONFIG,
} from "../config";

task("test_deploy", "Run all deployment scripts on a temp Hardhat node", async (_args, hre) => {
    const { ethers } = hre;
    await hre.run("compile");

    console.log();
    console.log("[+] Deploying mock contracts");
    await hre.run("deploy_mock");
    const mockAddresses = await selectAddressFile(hre, "mock", "latest");

    console.log();
    console.log("[+] Deploying oracle contracts");
    APR_ORACLE_CONFIG.V_TOKEN = mockAddresses.mockVToken;
    await hre.run("deploy_oracle");

    console.log();
    console.log("[+] Deploying governance contracts");
    GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP = endOfWeek(new Date().getTime());
    await hre.run("deploy_governance");

    console.log();
    console.log("[+] Deploying fund contracts");
    FUND_CONFIG.UNDERLYING_ADDRESS = mockAddresses.mockBtc;
    FUND_CONFIG.TWAP_ORACLE_ADDRESS = mockAddresses.mockTwapOracle;
    FUND_CONFIG.APR_ORACLE_ADDRESS = mockAddresses.mockAprOracle;
    FUND_CONFIG.MIN_CREATION = "0.1";
    FUND_CONFIG.GUARDED_LAUNCH = true;
    await hre.run("deploy_fund", { governance: "latest" });

    console.log();
    console.log("[+] Deploying exchange contracts");
    EXCHANGE_CONFIG.QUOTE_ADDRESS = mockAddresses.mockUsdc;
    EXCHANGE_CONFIG.MIN_ORDER_AMOUNT = "0.1";
    EXCHANGE_CONFIG.GUARDED_LAUNCH_MIN_ORDER_AMOUNT = "0.01";
    EXCHANGE_CONFIG.MAKER_REQUIREMENT = "0";
    await hre.run("deploy_exchange", { governance: "latest", fund: "latest" });

    console.log();
    console.log("[+] Deploying misc contracts");
    await hre.run("deploy_misc", { silent: true });

    console.log();
    console.log("[+] Deploying two vesting escrows");
    await hre.run("deploy_vesting", {
        governance: "latest",
        amount: "1",
        recipient: ethers.Wallet.createRandom().address,
        startWeek: "10",
        durationWeek: "20",
        cliffPercent: "0",
    });
    await new Promise((r) => setTimeout(r, 1000)); // Sleep 1s to avoid address file name collision
    await hre.run("deploy_vesting", {
        governance: "latest",
        amount: "1000000",
        recipient: ethers.Wallet.createRandom().address,
        startWeek: "20",
        durationWeek: "1",
        cliffPercent: "10",
    });
});
