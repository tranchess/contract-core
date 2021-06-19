import { task } from "hardhat/config";
import { createAddressFile, selectAddressFile } from "./address_file";
import { GOVERNANCE_CONFIG, FUND_CONFIG, EXCHANGE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

task("deploy_exchange", "Deploy exchange contracts")
    .addOptionalParam("governance", "Path to the governance address file", "")
    .addOptionalParam("fund", "Path to the fund address file", "")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;

        await hre.run("compile");
        const addressFile = createAddressFile(hre, "exchange");
        const governanceAddresses = await selectAddressFile(hre, "governance", args.governance);
        const fundAddresses = await selectAddressFile(hre, "fund", args.fund);

        const quoteToken = await ethers.getContractAt("ERC20", EXCHANGE_CONFIG.QUOTE_ADDRESS);
        const quoteDecimals = await quoteToken.decimals();

        const Exchange = await ethers.getContractFactory("Exchange");
        const exchangeImpl = await Exchange.deploy(
            fundAddresses.fund,
            governanceAddresses.chessSchedule,
            governanceAddresses.chessController,
            quoteToken.address,
            quoteDecimals,
            governanceAddresses.votingEscrow,
            parseEther(EXCHANGE_CONFIG.MIN_ORDER_AMOUNT),
            parseEther(EXCHANGE_CONFIG.MIN_ORDER_AMOUNT),
            parseEther(EXCHANGE_CONFIG.MAKER_REQUIREMENT),
            FUND_CONFIG.GUARDED_LAUNCH ? GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP : 0,
            parseEther(EXCHANGE_CONFIG.GUARDED_LAUNCH_MIN_ORDER_AMOUNT)
        );
        console.log(`Exchange implementation: ${exchangeImpl.address}`);
        addressFile.set("exchangeImpl", exchangeImpl.address);

        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const exchangeProxy = await TransparentUpgradeableProxy.deploy(
            exchangeImpl.address,
            governanceAddresses.proxyAdmin,
            "0x",
            { gasLimit: 1e6 } // Gas estimation may fail
        );
        const exchange = Exchange.attach(exchangeProxy.address);
        console.log(`Exchange: ${exchange.address}`);
        addressFile.set("exchange", exchange.address);

        const chessSchedule = await ethers.getContractAt(
            "ChessSchedule",
            governanceAddresses.chessSchedule
        );
        if ((await chessSchedule.owner()) === (await chessSchedule.signer.getAddress())) {
            await chessSchedule.addMinter(exchange.address);
            console.log("Exchange is a CHESS minter now");

            console.log("Transfering ownership of ChessSchedule to TimelockController");
            await chessSchedule.transferOwnership(governanceAddresses.timelockController);
        } else {
            console.log("NOTE: Please add Exchange as a minter of ChessSchedule");
        }
    });
