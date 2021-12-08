import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { TwapOracleAddresses } from "./deploy_twap_oracle";
import type { BscAprOracleAddresses } from "./deploy_bsc_apr_oracle";
import type { StrategyAddresses } from "./deploy_bsc_staking_strategy";
import { GOVERNANCE_CONFIG, FUND_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface FundAddresses extends Addresses {
    underlyingSymbol: string;
    underlying: string;
    quoteSymbol: string;
    quote: string;
    twapOracle: string;
    aprOracle: string;
    feeDistributor: string;
    fund: string;
    shareM: string;
    shareA: string;
    shareB: string;
    primaryMarket: string;
}

task("deploy_fund_v2", "Deploy fund contracts")
    .addParam("underlyingSymbol", "Underlying token symbol")
    .addParam("quoteSymbol", "Quote token symbol")
    .addParam("shareSymbolPrefix", "Symbol prefix of share tokens")
    .addParam("adminFeeRate", "Admin fraction in the fee distributor")
    .addParam("fundCap", "Fund cap (in underlying's precision), or -1 for no cap")
    .addParam("strategy", "Name of the strategy (snake_case), or 'NONE' for no strategy")
    .addOptionalParam(
        "strategyParams",
        "Strategy parameters in JSON (param names in camelCase)",
        ""
    )
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { BigNumber } = ethers;
        const { parseEther, parseUnits } = ethers.utils;
        await hre.run("compile");

        const underlyingSymbol: string = args.underlyingSymbol;
        assert.match(underlyingSymbol, /^[a-zA-Z]+$/, "Invalid symbol");
        const quoteSymbol: string = args.quoteSymbol;
        assert.match(quoteSymbol, /^[a-zA-Z]+$/, "Invalid symbol");
        const shareSymbolPrefix: string = args.shareSymbolPrefix;
        assert.match(shareSymbolPrefix, /^[a-zA-Z.]+$/, "Invalid symbol prefix");
        assert.ok(shareSymbolPrefix.length <= 5, "Symbol prefix too long");
        const adminFeeRate = parseEther(args.adminFeeRate);

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const twapOracleAddresses = loadAddressFile<TwapOracleAddresses>(
            hre,
            `twap_oracle_${underlyingSymbol.toLowerCase()}`
        );
        const bscAprOracleAddresses = loadAddressFile<BscAprOracleAddresses>(
            hre,
            `bsc_apr_oracle_${quoteSymbol.toLowerCase()}`
        );

        const underlyingToken = await ethers.getContractAt("ERC20", twapOracleAddresses.token);
        const underlyingDecimals = await underlyingToken.decimals();
        assert.strictEqual(underlyingSymbol, await underlyingToken.symbol());
        const quoteToken = await ethers.getContractAt("ERC20", bscAprOracleAddresses.token);
        assert.strictEqual(quoteSymbol, await quoteToken.symbol());
        console.log(`Underlying: ${underlyingToken.address}`);
        console.log(`Quote: ${quoteToken.address}`);

        const fundCap =
            args.fundCap === "-1"
                ? BigNumber.from(1).shl(256).sub(1)
                : parseUnits(args.fundCap, underlyingDecimals);

        const strategyName: string = args.strategy;
        assert.match(strategyName, /^[a-z_]+|NONE$/, "Strategy name should be in snake_case");
        if (strategyName !== "NONE") {
            assert.ok(
                Object.keys(hre.tasks).includes(`deploy_${strategyName}`),
                "Cannot find deployment task for the strategy"
            );
        }
        const strategyParams = args.strategyParams ? JSON.parse(args.strategyParams) : {};

        const FeeDistributor = await ethers.getContractFactory("FeeDistributor");
        const feeDistributor = await FeeDistributor.deploy(
            underlyingToken.address,
            governanceAddresses.votingEscrow,
            GOVERNANCE_CONFIG.TREASURY || (await FeeDistributor.signer.getAddress()), // admin
            adminFeeRate
        );
        console.log(`FeeDistributor: ${feeDistributor.address}`);

        const Fund = await ethers.getContractFactory("FundV2");
        const fund = await Fund.deploy(
            underlyingToken.address,
            underlyingDecimals,
            parseEther("0.000027534787632697"), // 1 - 0.99 ^ (1/365)
            parseEther("2"),
            parseEther("0.5"),
            twapOracleAddresses.twapOracle,
            bscAprOracleAddresses.bscAprOracle,
            governanceAddresses.interestRateBallot,
            GOVERNANCE_CONFIG.TREASURY || (await Fund.signer.getAddress()), // fee collector
            { gasLimit: 5e6 } // Gas estimation may fail
        );
        console.log(`Fund: ${fund.address}`);
        console.log(
            "Please change fee collector address to FeeDistributor after people call syncWithVotingEscrow()"
        );

        const Share = await ethers.getContractFactory("Share");
        const shareM = await Share.deploy(
            `Tranchess ${underlyingSymbol} QUEEN`,
            `${shareSymbolPrefix}QUEEN`,
            fund.address,
            0
        );
        console.log(`ShareM: ${shareM.address}`);

        const shareA = await Share.deploy(
            `Tranchess ${underlyingSymbol} BISHOP`,
            `${shareSymbolPrefix}BISHOP`,
            fund.address,
            1
        );
        console.log(`ShareA: ${shareA.address}`);

        const shareB = await Share.deploy(
            `Tranchess ${underlyingSymbol} ROOK`,
            `${shareSymbolPrefix}ROOK`,
            fund.address,
            2
        );
        console.log(`ShareB: ${shareB.address}`);

        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV2");
        const primaryMarket = await PrimaryMarket.deploy(
            fund.address,
            parseEther("0.002"),
            parseEther("0.0005"),
            parseEther("0.0005"),
            parseUnits(FUND_CONFIG.MIN_CREATION, underlyingDecimals),
            fundCap,
            { gasLimit: 5e6 } // Gas estimation may fail
        );
        console.log(`PrimaryMarket: ${primaryMarket.address}`);

        let strategyAddress = ethers.constants.AddressZero;
        if (strategyName !== "NONE") {
            console.log("Deploying strategy");
            await hre.run(`deploy_${strategyName}`, { ...strategyParams, fund: fund.address });
            const strategyAddresses = loadAddressFile<StrategyAddresses>(hre, strategyName);
            strategyAddress = strategyAddresses.strategy;
        }

        console.log("Initializing Fund");
        await fund.initialize(
            shareM.address,
            shareA.address,
            shareB.address,
            primaryMarket.address,
            strategyAddress
        );

        console.log("Transfering ownership to TimelockController");
        await feeDistributor.transferOwnership(governanceAddresses.timelockController);
        await primaryMarket.transferOwnership(governanceAddresses.timelockController);
        await fund.transferOwnership(governanceAddresses.timelockController);

        const addresses: FundAddresses = {
            ...newAddresses(hre),
            underlyingSymbol,
            underlying: underlyingToken.address,
            quoteSymbol,
            quote: quoteToken.address,
            twapOracle: twapOracleAddresses.twapOracle,
            aprOracle: bscAprOracleAddresses.bscAprOracle,
            feeDistributor: feeDistributor.address,
            fund: fund.address,
            shareM: shareM.address,
            shareA: shareA.address,
            shareB: shareB.address,
            primaryMarket: primaryMarket.address,
        };
        saveAddressFile(hre, `fund_${underlyingSymbol.toLowerCase()}`, addresses);
    });
