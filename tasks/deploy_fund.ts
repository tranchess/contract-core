import { task } from "hardhat/config";
import { createAddressFile, selectAddressFile } from "./address_file";
import { FUND_CONFIG } from "../config";

task("deploy_fund", "Deploy fund contracts")
    .addOptionalParam("governance", "Path to the governance address file", "")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const { parseEther, parseUnits } = ethers.utils;

        await hre.run("compile");
        const [deployer] = await ethers.getSigners();
        const addressFile = createAddressFile("fund");
        const governanceAddresses = await selectAddressFile("governance", args.governance);

        const underlyingToken = await ethers.getContractAt("ERC20", FUND_CONFIG.UNDERLYING_ADDRESS);
        const underlyingDecimals = await underlyingToken.decimals();
        const underlyingSymbol = await underlyingToken.symbol();
        console.log(`Underlying: ${underlyingToken.address}`);
        addressFile.set("underlying", underlyingToken.address);

        addressFile.set("twapOracle", FUND_CONFIG.TWAP_ORACLE_ADDRESS);
        addressFile.set("aprOracle", FUND_CONFIG.APR_ORACLE_ADDRESS);

        const Fund = await ethers.getContractFactory("Fund");
        const fund = await Fund.deploy(
            underlyingToken.address,
            underlyingDecimals,
            parseEther("0.000027534787632697"), // 1 - 0.99 ^ (1/365)
            parseEther("2"),
            parseEther("0.5"),
            FUND_CONFIG.TWAP_ORACLE_ADDRESS,
            FUND_CONFIG.APR_ORACLE_ADDRESS,
            governanceAddresses.interestRateBallot,
            deployer.address // FIXME read from configuration
        );
        console.log(`Fund: ${fund.address}`);
        addressFile.set("fund", fund.address);

        const Share = await ethers.getContractFactory("Share");
        const shareM = await Share.deploy(
            `Tranchess ${underlyingSymbol} Class M`,
            `t${underlyingSymbol}.M`,
            fund.address,
            0
        );
        console.log(`ShareM: ${shareM.address}`);
        addressFile.set("shareM", shareM.address);

        const shareA = await Share.deploy(
            `Tranchess ${underlyingSymbol} Class A`,
            `t${underlyingSymbol}.A`,
            fund.address,
            0
        );
        console.log(`ShareA: ${shareA.address}`);
        addressFile.set("shareA", shareA.address);

        const shareB = await Share.deploy(
            `Tranchess ${underlyingSymbol} Class B`,
            `t${underlyingSymbol}.B`,
            fund.address,
            0
        );
        console.log(`ShareB: ${shareB.address}`);
        addressFile.set("shareB", shareB.address);

        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarket");
        const primaryMarket = await PrimaryMarket.deploy(
            fund.address,
            parseEther("0.001"),
            parseEther("0.0005"),
            parseEther("0.0005"),
            parseUnits(FUND_CONFIG.MIN_CREATION, underlyingDecimals)
        );
        console.log(`PrimaryMarket: ${primaryMarket.address}`);
        addressFile.set("primaryMarket", primaryMarket.address);

        console.log("Initializing Fund");
        await fund.initialize(
            shareM.address,
            shareA.address,
            shareB.address,
            primaryMarket.address
        );
    });
