import fs = require("fs");
import path = require("path");
import { task } from "hardhat/config";
import {
    getAddressDir,
    listAddressFile,
    loadAddressFile,
    newAddresses,
    saveAddressFile,
} from "./address_file";
import type { TwapOracleAddresses } from "./deploy_twap_oracle";
import type { MockAddresses } from "./deploy_mock";
import { endOfWeek, GOVERNANCE_CONFIG, FUND_CONFIG } from "../config";

task("test_deploy", "Run all deployment scripts on a temp Hardhat node", async (_args, hre) => {
    const { ethers } = hre;
    await hre.run("compile");
    const [deployer] = await ethers.getSigners();

    console.log();
    console.log("[+] Deploying mock contracts");
    await hre.run("deploy_mock", { silent: true, initialTwap: "10000" });
    const mockAddresses = loadAddressFile<MockAddresses>(hre, "mock");

    console.log();
    console.log("[+] Deploying TwapOracle");
    await hre.run("deploy_twap_oracle", { token: mockAddresses.mockBtc, oracleSymbol: "BTC" });
    await hre.run("deploy_twap_oracle", { token: mockAddresses.mockEth, oracleSymbol: "ETH" });

    console.log();
    console.log("[+] Deploying BscAprOracle");
    await hre.run("deploy_bsc_apr_oracle", {
        token: mockAddresses.mockUsdc,
        vToken: mockAddresses.mockVToken,
    });

    console.log();
    console.log("[+] Deploying governance contracts");
    GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP = endOfWeek(new Date().getTime());
    await hre.run("deploy_governance");

    console.log();
    console.log("[+] Changing TwapOracle address files for test");
    const addressDir = getAddressDir(hre);
    for (const symbol of ["btc", "eth"]) {
        const twapAddresses = loadAddressFile<TwapOracleAddresses>(hre, `twap_oracle_${symbol}`);
        const twapAddressFilename = path.join(
            addressDir,
            listAddressFile(addressDir, `twap_oracle_${symbol}`)[0]
        );
        fs.renameSync(twapAddressFilename, twapAddressFilename + ".orig");
        twapAddresses.twapOracle = mockAddresses.mockTwapOracle;
        saveAddressFile(hre, `twap_oracle_${symbol}`, twapAddresses);
    }
    {
        const wbnbTwapAddresses: TwapOracleAddresses = {
            ...newAddresses(hre),
            token: mockAddresses.mockWbnb,
            oracleSymbol: "BNB",
            twapOracle: mockAddresses.mockTwapOracle,
        };
        saveAddressFile(hre, `twap_oracle_wbnb`, wbnbTwapAddresses);
    }

    console.log();
    console.log("[+] Deploying fund contracts");
    FUND_CONFIG.MIN_CREATION = "0.1";
    FUND_CONFIG.GUARDED_LAUNCH = true;
    await hre.run("deploy_fund", {
        underlyingSymbol: "BTC",
        quoteSymbol: "USDC",
        shareSymbolPrefix: "b",
        adminFeeRate: "0.5",
    });
    await hre.run("deploy_fund", {
        underlyingSymbol: "ETH",
        quoteSymbol: "USDC",
        shareSymbolPrefix: "e",
        adminFeeRate: "0.5",
    });
    await hre.run("deploy_fund_v2", {
        underlyingSymbol: "WBNB",
        quoteSymbol: "USDC",
        shareSymbolPrefix: "n",
        adminFeeRate: "0.5",
        fundCap: "1000000",
        strategy: "bsc_staking_strategy",
        strategyParams: JSON.stringify({
            staker: deployer.address,
            performanceFeeRate: "0.2",
        }),
    });

    console.log();
    console.log("[+] Deploying exchange contracts");
    await hre.run("deploy_exchange", { underlyingSymbol: "BTC" });
    await hre.run("deploy_exchange", { underlyingSymbol: "ETH" });
    await hre.run("deploy_exchange", { underlyingSymbol: "WBNB" });

    console.log();
    console.log("[+] Deploying misc contracts");
    await hre.run("deploy_misc", {
        silent: true,
        deployProtocolDataProvider: true,
        deployBatchSettleHelper: true,
        deployBatchOperationHelper: true,
        deployVotingEscrowHelper: true,
        underlyingSymbols: "BTC,ETH,WBNB",
    });

    console.log();
    console.log("[+] Deploying address whitelist");
    await hre.run("deploy_address_whitelist", {
        whitelist: deployer.address + "," + ethers.constants.AddressZero,
    });

    console.log();
    console.log("[+] Deploying implementation contracts (again)");
    await hre.run("deploy_chess_controller_impl", {
        underlyingSymbols: "BTC,ETH",
        launchDate: new Date().toJSON().split("T")[0],
    });
    await hre.run("deploy_chess_schedule_impl");
    await hre.run("deploy_voting_escrow_impl");
    await hre.run("deploy_exchange_impl", { underlyingSymbol: "BTC" });

    console.log();
    console.log("[+] Deploying two vesting escrows");
    await hre.run("deploy_vesting", {
        amount: "1",
        recipient: ethers.Wallet.createRandom().address,
        startWeek: "10",
        durationWeek: "20",
        cliffPercent: "0",
    });
    await new Promise((r) => setTimeout(r, 1000)); // Sleep 1s to avoid address file name collision
    await hre.run("deploy_vesting", {
        amount: "1000000",
        recipient: ethers.Wallet.createRandom().address,
        startWeek: "20",
        durationWeek: "1",
        cliffPercent: "10",
    });
});
