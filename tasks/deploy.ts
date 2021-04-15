import { task } from "hardhat/config";
import fs = require("fs");
import path = require("path");
import editJsonFile = require("edit-json-file");
import {
    TEST_TWAP_ORACLE,
    TEST_APR_ORACLE,
    TEST_WBTC,
    TEST_USDC,
    STAGING_TWAP_ORACLE,
    STAGING_APR_ORACLE,
    STAGING_WBTC,
    STAGING_USDC,
} from "../config";
import { BigNumber } from "ethers";

task("deploy", "Deploy contracts", async (_args, hre) => {
    const { ethers } = hre;
    const { parseEther, parseUnits } = ethers.utils;

    const CONTRACT_ADDRESS_DIR = path.join(__dirname, "..", "cache");
    if (!fs.existsSync(CONTRACT_ADDRESS_DIR)) {
        fs.mkdirSync(CONTRACT_ADDRESS_DIR);
    }
    const contractAddress = editJsonFile(path.join(CONTRACT_ADDRESS_DIR, "contract_address.json"), {
        autosave: true,
    });
    const [deployer] = await ethers.getSigners();

    await hre.run("compile");

    let twapOracleAddress;
    let aprOracleAddress;
    let wbtcAddress;
    let usdcAddress;
    if (hre.network.name === "test") {
        twapOracleAddress = TEST_TWAP_ORACLE;
        aprOracleAddress = TEST_APR_ORACLE;
        wbtcAddress = TEST_WBTC;
        usdcAddress = TEST_USDC;
    } else if (hre.network.name === "staging") {
        twapOracleAddress = STAGING_TWAP_ORACLE;
        aprOracleAddress = STAGING_APR_ORACLE;
        wbtcAddress = STAGING_WBTC;
        usdcAddress = STAGING_USDC;
    }

    if (!twapOracleAddress) {
        const MockTwapOracle = await ethers.getContractFactory("MockTwapOracle");
        const mockTwapOracle = await MockTwapOracle.deploy();
        twapOracleAddress = mockTwapOracle.address;
        contractAddress.set("test.mock_twap_oracle", twapOracleAddress);
        console.log("TwapOracle:", twapOracleAddress);
        await mockTwapOracle.updateYesterdayPrice(parseEther("20000"));
    }

    if (!aprOracleAddress) {
        const MockAprOracle = await ethers.getContractFactory("MockAprOracle");
        const mockAprOracle = await MockAprOracle.deploy();
        aprOracleAddress = mockAprOracle.address;
        contractAddress.set("test.mock_apr_oracle", aprOracleAddress);
        console.log("AprOracle:", aprOracleAddress);
    }

    const MockToken = await ethers.getContractFactory("MockToken");
    let wbtc;
    if (!wbtcAddress) {
        wbtc = await MockToken.deploy("Mock WBTC", "WBTC", 8);
        await wbtc.mint(deployer.address, 1000000e8);
        wbtcAddress = wbtc.address;
        contractAddress.set("test.mock_wbtc", wbtcAddress);
        console.log("WBTC:", wbtcAddress);
    } else {
        wbtc = await MockToken.attach(wbtcAddress);
    }
    const wbtcDecimals = await wbtc.decimals();
    if (!usdcAddress) {
        const usdc = await MockToken.deploy("Mock USDC", "USDC", 6);
        await usdc.mint(deployer.address, 1000000e6);
        usdcAddress = usdc.address;
        contractAddress.set("test.mock_usdc", usdcAddress);
        console.log("USDC:", usdcAddress);
    }

    const Fund = await ethers.getContractFactory("Fund");
    const fund = await Fund.deploy(
        parseEther("0.000027534787632697"), // 1 - 0.99 ^ (1/365)
        parseEther("1.5"),
        parseEther("0.5"),
        parseEther("1.1"),
        twapOracleAddress
    );
    contractAddress.set("test.fund", fund.address);
    console.log("Fund:", fund.address);

    const Chess = await ethers.getContractFactory("Chess");
    const chess = await Chess.deploy();
    await chess.addMinter(deployer.address);
    contractAddress.set("test.chess", chess.address);
    console.log("Chess:", chess.address);

    const VotingEscrow = await ethers.getContractFactory("VotingEscrow");
    const votingEscrow = await VotingEscrow.deploy(
        chess.address,
        ethers.constants.AddressZero,
        "Chess Vote",
        "veCHESS",
        BigNumber.from(4 * 365 * 24 * 60 * 60)
    );
    contractAddress.set("test.voting_escrow", votingEscrow.address);
    console.log("VotingEscrow:", votingEscrow.address);

    const Share = await ethers.getContractFactory("Share");
    const shareP = await Share.deploy("Tranchess WBTC Class P", "tWBTC.P", fund.address, 0);
    contractAddress.set("test.share_p", shareP.address);
    console.log("ShareP:", shareP.address);

    const shareA = await Share.deploy("Tranchess WBTC Class A", "tWBTC.A", fund.address, 1);
    contractAddress.set("test.share_a", shareA.address);
    console.log("ShareA:", shareA.address);

    const shareB = await Share.deploy("Tranchess WBTC Class B", "tWBTC.B", fund.address, 2);
    contractAddress.set("test.share_b", shareB.address);
    console.log("ShareB:", shareB.address);

    const InterestRateBallot = await ethers.getContractFactory("InterestRateBallot");
    const interestRateBallot = await InterestRateBallot.deploy(votingEscrow.address);
    contractAddress.set("test.ballot", interestRateBallot.address);
    console.log("InterestRateBallot:", interestRateBallot.address);

    const PrimaryMarket = await ethers.getContractFactory("PrimaryMarket");
    const primaryMarket = await PrimaryMarket.deploy(
        fund.address,
        parseEther("0"),
        parseEther("0.001"),
        parseEther("0.0005"),
        parseEther("0.0005"),
        parseUnits("0.5", wbtcDecimals)
    );
    contractAddress.set("test.primary_market", primaryMarket.address);
    console.log("PrimaryMarket:", primaryMarket.address);

    console.log("Initialize Fund");
    await fund.initialize(
        wbtcAddress,
        wbtcDecimals,
        shareP.address,
        shareA.address,
        shareB.address,
        aprOracleAddress,
        interestRateBallot.address,
        primaryMarket.address,
        deployer.address // FIXME read from configuration
    );
});
