import { task } from "hardhat/config";
import fs = require("fs");
import path = require("path");
import editJsonFile = require("edit-json-file");
import {
    TEST_TWAP_ORACLE,
    TEST_APR_ORACLE,
    TEST_WBTC,
    TEST_USDC,
    TEST_MIN_CREATION,
    STAGING_TWAP_ORACLE,
    STAGING_APR_ORACLE,
    STAGING_WBTC,
    STAGING_USDC,
    STAGING_MIN_CREATION,
    BSC_TESTNET_VUSDC_ADDRESS,
} from "../config";
import { BigNumber } from "ethers";

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
    const { AddressZero } = ethers.constants;

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

    let twapOracleAddress;
    let aprOracleAddress;
    let wbtcAddress;
    let usdcAddress;
    let minCreation;
    if (hre.network.name === "test" || hre.network.name === "hardhat") {
        twapOracleAddress = TEST_TWAP_ORACLE;
        aprOracleAddress = TEST_APR_ORACLE;
        wbtcAddress = TEST_WBTC;
        usdcAddress = TEST_USDC;
        minCreation = TEST_MIN_CREATION;
    } else if (hre.network.name === "staging") {
        twapOracleAddress = STAGING_TWAP_ORACLE;
        aprOracleAddress = STAGING_APR_ORACLE;
        wbtcAddress = STAGING_WBTC;
        usdcAddress = STAGING_USDC;
        minCreation = STAGING_MIN_CREATION;
    } else {
        console.error("ERROR: Unknown hardhat network:", hre.network.name);
        return;
    }

    if (!twapOracleAddress) {
        const MockTwapOracle = await ethers.getContractFactory("MockTwapOracle");
        const mockTwapOracle = await MockTwapOracle.deploy();
        twapOracleAddress = mockTwapOracle.address;
        addressFile.set("mock_twap_oracle", twapOracleAddress);
        console.log("TwapOracle:", twapOracleAddress);
        await mockTwapOracle.updateYesterdayPrice(parseEther("20000"));
    }
    addressFile.set("twap_oracle", twapOracleAddress);

    const MockToken = await ethers.getContractFactory("MockToken");
    let wbtc;
    if (!wbtcAddress) {
        wbtc = await MockToken.deploy("Mock WBTC", "WBTC", 8);
        await wbtc.mint(deployer.address, 1000000e8);
        wbtcAddress = wbtc.address;
        addressFile.set("mock_wbtc", wbtcAddress);
        console.log("WBTC:", wbtcAddress);
    } else {
        wbtc = await MockToken.attach(wbtcAddress);
    }
    addressFile.set("wbtc", wbtcAddress);
    const wbtcDecimals = await wbtc.decimals();
    if (!usdcAddress) {
        const usdc = await MockToken.deploy("Mock USDC", "USDC", 6);
        await usdc.mint(deployer.address, 1000000e6);
        usdcAddress = usdc.address;
        addressFile.set("mock_usdc", usdcAddress);
        console.log("USDC:", usdcAddress);
    }
    addressFile.set("usdc", usdcAddress);

    const Fund = await ethers.getContractFactory("Fund");
    const fund = await Fund.deploy(
        parseEther("0.000027534787632697"), // 1 - 0.99 ^ (1/365)
        parseEther("1.5"),
        parseEther("0.5"),
        parseEther("1.1"),
        twapOracleAddress
    );
    addressFile.set("fund", fund.address);
    console.log("Fund:", fund.address);

    if (!aprOracleAddress) {
        if (hre.network.name === "test" || hre.network.name === "hardhat") {
            const MockAprOracle = await ethers.getContractFactory("MockAprOracle");
            const mockAprOracle = await MockAprOracle.deploy();
            aprOracleAddress = mockAprOracle.address;
            addressFile.set("mock_apr_oracle", aprOracleAddress);
        } else {
            const BscAprOracle = await ethers.getContractFactory("BscAprOracle");
            const bscAprOracle = await BscAprOracle.deploy(
                "Venus USDC APR oracle",
                BSC_TESTNET_VUSDC_ADDRESS
            );
            aprOracleAddress = bscAprOracle.address;
            addressFile.set("bsc_apr_oracle", aprOracleAddress);
        }
        console.log("AprOracle:", aprOracleAddress);
    }
    addressFile.set("apr_oracle", aprOracleAddress);

    const Chess = await ethers.getContractFactory("Chess");
    const chess = await Chess.deploy();
    await chess.addMinter(deployer.address);
    addressFile.set("chess", chess.address);
    console.log("Chess:", chess.address);

    const VotingEscrow = await ethers.getContractFactory("VotingEscrow");
    const votingEscrow = await VotingEscrow.deploy(
        chess.address,
        ethers.constants.AddressZero,
        "Chess Vote",
        "veCHESS",
        BigNumber.from(4 * 365 * 24 * 60 * 60)
    );
    addressFile.set("voting_escrow", votingEscrow.address);
    console.log("VotingEscrow:", votingEscrow.address);

    const Share = await ethers.getContractFactory("Share");
    const shareM = await Share.deploy("Tranchess WBTC Class M", "tWBTC.M", fund.address, 0);
    addressFile.set("share_m", shareM.address);
    console.log("ShareM:", shareM.address);

    const shareA = await Share.deploy("Tranchess WBTC Class A", "tWBTC.A", fund.address, 1);
    addressFile.set("share_a", shareA.address);
    console.log("ShareA:", shareA.address);

    const shareB = await Share.deploy("Tranchess WBTC Class B", "tWBTC.B", fund.address, 2);
    addressFile.set("share_b", shareB.address);
    console.log("ShareB:", shareB.address);

    const InterestRateBallot = await ethers.getContractFactory("InterestRateBallot");
    const interestRateBallot = await InterestRateBallot.deploy(votingEscrow.address);
    addressFile.set("interest_rate_ballot", interestRateBallot.address);
    console.log("InterestRateBallot:", interestRateBallot.address);

    const PrimaryMarket = await ethers.getContractFactory("PrimaryMarket");
    const primaryMarket = await PrimaryMarket.deploy(
        fund.address,
        parseEther("0.001"),
        parseEther("0.0005"),
        parseEther("0.0005"),
        parseUnits(minCreation, wbtcDecimals)
    );
    addressFile.set("primary_market", primaryMarket.address);
    console.log("PrimaryMarket:", primaryMarket.address);

    const Timelock = await ethers.getContractFactory("Timelock");
    const timelock = await Timelock.deploy(
        BigNumber.from(24 * 60 * 60), // minDelay
        [deployer.address], // proposers
        [AddressZero] // executor
    );
    addressFile.set("timelock", timelock.address);
    console.log("Timelock:", timelock.address);

    console.log(`Contract addresses written to file "${addressFilename}"`);

    console.log(
        "Trying to initialize the fund, which may fail if price at the last settlement time" +
            " is not available in the TwapOracle"
    );
    await hre.run("initialize_fund", { deploy: addressFilename });
    await hre.run("initialize_timelock", { deploy: addressFilename });
});
