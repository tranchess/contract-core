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
    await hre.run("compile");

    console.log();
    console.log("[+] Deploying mock contracts");
    await hre.run("deploy_mock");
    const mockAddresses = await selectAddressFile("mock", "latest");

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
    await hre.run("deploy_fund");

    console.log();
    console.log("[+] Deploying exchange contracts");
    EXCHANGE_CONFIG.QUOTE_ADDRESS = mockAddresses.mockUsdc;
    EXCHANGE_CONFIG.MIN_ORDER_AMOUNT = "0.1";
    EXCHANGE_CONFIG.MAKER_REQUIREMENT = "0";
    await hre.run("deploy_exchange", { governance: "latest", fund: "latest" });

    console.log();
    console.log("[+] Initializing the fund");
    await hre.run("initialize_fund", { governance: "latest", fund: "latest" });
});
