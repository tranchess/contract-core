import { task } from "hardhat/config";
import { loadAddressFile } from "./address_file";
import type { MockAddresses } from "./deploy_mock";
import type { LzAddresses } from "./dev_deploy_lz";
import { endOfWeek, GOVERNANCE_CONFIG } from "../config";

task("test_deploy", "Run all deployment scripts on a temp Hardhat node", async (_args, hre) => {
    const { ethers } = hre;
    await hre.run("compile");
    const [deployer] = await ethers.getSigners();

    console.log();
    console.log("[+] Deploying mock contracts");
    await hre.run("deploy_mock", { silent: true });
    const mockAddresses = loadAddressFile<MockAddresses>(hre, "mock");

    console.log();
    console.log("[+] Deploying LayerZero");
    await hre.run("dev_deploy_lz");
    const lzAddresses = loadAddressFile<LzAddresses>(hre, "dev_lz");
    GOVERNANCE_CONFIG.LZ_ENDPOINT = lzAddresses.endpoint;

    console.log();
    console.log("[+] Deploying mock TwapOracle");
    await hre.run("deploy_mock_twap_oracle", {
        token: mockAddresses.mockBtc,
        oracleSymbol: "BTC",
        initialTwap: "10000",
    });
    await hre.run("deploy_mock_twap_oracle", {
        token: mockAddresses.mockEth,
        oracleSymbol: "ETH",
        initialTwap: "3000",
    });
    await hre.run("deploy_mock_twap_oracle", {
        token: mockAddresses.mockWbnb,
        oracleSymbol: "WBNB",
        initialTwap: "500",
    });

    console.log();
    console.log("[+] Deploying BscAprOracle");
    await hre.run("deploy_bsc_apr_oracle", {
        token: mockAddresses.mockBusd,
        vToken: mockAddresses.mockVToken,
    });

    console.log();
    console.log("[+] Deploying governance contracts");
    GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP = endOfWeek(new Date().getTime() / 1000);
    await hre.run("deploy_governance");

    console.log();
    console.log("[+] Deploying fund contracts");
    await hre.run("deploy_fee_distributor", {
        underlying: mockAddresses.mockBtc,
        adminFeeRate: "0.5",
    });
    await hre.run("deploy_fee_distributor", {
        underlying: mockAddresses.mockEth,
        adminFeeRate: "0.5",
    });
    await hre.run("deploy_fee_distributor", {
        underlying: mockAddresses.mockWbnb,
        adminFeeRate: "0.5",
    });
    await hre.run("deploy_fee_distributor", {
        underlying: mockAddresses.mockBusd,
        adminFeeRate: "0.5",
    });
    await hre.run("deploy_fee_distributor", {
        underlying: mockAddresses.mockWstEth,
        adminFeeRate: "0.5",
    });
    await hre.run("deploy_fund", {
        underlyingSymbol: "BTC",
        quoteSymbol: "BUSD",
        shareSymbolPrefix: "b",
        redemptionFeeRate: "0.0035",
        mergeFeeRate: "0.0045",
        fundCap: "-1",
        strategy: "NONE",
        fundInitializationParams: JSON.stringify({
            newSplitRatio: "500",
            lastNavB: "1",
            lastNavR: "1",
        }),
    });
    await hre.run("deploy_fund", {
        underlyingSymbol: "ETH",
        quoteSymbol: "BUSD",
        shareSymbolPrefix: "e",
        redemptionFeeRate: "0.0035",
        mergeFeeRate: "0.0045",
        fundCap: "-1",
        strategy: "NONE",
        fundInitializationParams: JSON.stringify({
            newSplitRatio: "500",
            lastNavB: "1",
            lastNavR: "1",
        }),
    });
    await hre.run("deploy_fund", {
        underlyingSymbol: "WBNB",
        quoteSymbol: "BUSD",
        shareSymbolPrefix: "n",
        redemptionFeeRate: "0.0035",
        mergeFeeRate: "0.0045",
        fundCap: "1000000",
        strategy: "bsc_staking_strategy",
        strategyParams: JSON.stringify({
            staker: deployer.address,
            performanceFeeRate: "0.2",
        }),
        fundInitializationParams: JSON.stringify({
            newSplitRatio: "500",
            lastNavB: "1",
            lastNavR: "1",
        }),
    });

    await hre.run("deploy_fund_wsteth", {
        underlying: mockAddresses.mockWstEth,
        redemptionFeeRate: "0.0035",
        mergeFeeRate: "0.0045",
        bishopApr: "0.03",
        fundInitializationParams: JSON.stringify({
            newSplitRatio: "0.1",
            lastNavB: "1",
            lastNavR: "1",
        }),
    });

    await hre.run("deploy_maturity_fund", {
        underlying: mockAddresses.mockBusd,
        shareSymbols: "maturityQ,maturityB,maturityR",
        maturityDays: "180",
        redemptionFeeRate: "0.0035",
        mergeFeeRate: "0.0045",
        bishopApr: "0.03",
        fundInitializationParams: JSON.stringify({
            newSplitRatio: "0.1",
            lastNavB: "1",
            lastNavR: "1",
        }),
    });

    console.log();
    console.log("[+] Deploying misc contracts");
    await hre.run("deploy_misc", {
        silent: true,
        deployBatchOperationHelper: true,
    });

    console.log();
    console.log("[+] Deploying address whitelist");
    await hre.run("deploy_address_whitelist", {
        whitelist: deployer.address + "," + ethers.constants.AddressZero,
    });

    console.log();
    console.log("[+] Deploying implementation contracts (again)");
    await hre.run("deploy_chess_controller_impl", {
        firstUnderlyingSymbol: "BTC",
        launchDate: new Date().toJSON().split("T")[0],
    });
    await hre.run("deploy_chess_schedule_impl");
    await hre.run("deploy_voting_escrow_impl");

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

    console.log();
    console.log("[+] Deploying stable swaps");
    await hre.run("deploy_stable_swap", {
        kind: "Queen",
        underlyingSymbol: "WBNB",
        quote: mockAddresses.mockWbnb,
        bonus: mockAddresses.mockBusd,
        ampl: "85",
        feeRate: "0.03",
        adminFeeRate: "0.4",
    });
    for (const underlyingSymbol of ["BTC", "ETH", "WBNB"]) {
        await hre.run("deploy_stable_swap", {
            kind: "Bishop",
            underlyingSymbol: underlyingSymbol,
            quote: mockAddresses.mockBusd,
            bonus: mockAddresses.mockBusd,
            ampl: "85",
            feeRate: "0.03",
            adminFeeRate: "0.4",
            tradingCurbThreshold: "0.35",
            rewardStartTimestamp: "0",
        });
    }
    await hre.run("deploy_stable_swap_wsteth", {
        kind: "Bishop",
        ampl: "200",
        feeRate: "0.02",
        adminFeeRate: "0.4",
    });
    const WstETHWrappingSwap = await ethers.getContractFactory("WstETHWrappingSwap");
    const wstETHWrappingSwap = await WstETHWrappingSwap.deploy(mockAddresses.mockWstEth);
    console.log(`WstETHWrappingSwap: ${wstETHWrappingSwap.address}`);

    console.log();
    console.log("[+] Deploying swap router");
    await hre.run("deploy_swap_router", {
        wstWrappingSwap: wstETHWrappingSwap.address,
        queenSwaps: "WBNB",
        bishopSwaps: "BTC,ETH,WBNB,wstETH",
    });

    console.log();
    console.log("[+] Deploying flash swap router");
    await hre.run("deploy_flash_swap_router");

    console.log();
    console.log("[+] Deploying DataAggregator");
    await hre.run("deploy_data_aggregator", {
        firstUnderlyingSymbol: "BTC",
    });
});
