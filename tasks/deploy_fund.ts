import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { TwapOracleAddresses } from "./deploy_mock_twap_oracle";
import type { BscAprOracleAddresses } from "./deploy_bsc_apr_oracle";
import { updateHreSigner } from "./signers";
import { BigNumber } from "ethers";
import { StrategyAddresses } from "./deploy_bsc_staking_strategy";
import { FeeDistrubtorAddresses } from "./deploy_fee_distributor";

export interface FundAddresses extends Addresses {
    underlyingSymbol: string;
    underlying: string;
    quoteSymbol: string;
    quote: string;
    twapOracle: string;
    aprOracle: string;
    feeDistributor: string;
    fund: string;
    shareQ: string;
    shareB: string;
    shareR: string;
    primaryMarket: string;
    primaryMarketRouter: string;
    shareStaking: string;
}

task("deploy_fund", "Deploy fund contracts")
    .addParam("underlyingSymbol", "Underlying token symbol")
    .addParam("quoteSymbol", "Quote token symbol")
    .addParam("shareSymbolPrefix", "Symbol prefix of share tokens")
    .addParam("redemptionFeeRate", "Primary market redemption fee rate")
    .addParam("mergeFeeRate", "Primary market merge fee rate")
    .addParam("fundCap", "Fund cap (in underlying's precision), or -1 for no cap")
    .addParam("strategy", "Name of the strategy (snake_case), or 'NONE' for no strategy")
    .addOptionalParam(
        "strategyParams",
        "Strategy parameters in JSON (param names in camelCase)",
        ""
    )
    .addOptionalParam(
        "fundInitializationParams",
        "Parameters to call Fund.initialize() in JSON (param names in camelCase)",
        ""
    )
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther, parseUnits } = ethers.utils;
        await hre.run("compile");

        const underlyingSymbol: string = args.underlyingSymbol;
        assert.match(underlyingSymbol, /^[a-zA-Z]+$/, "Invalid symbol");
        const quoteSymbol: string = args.quoteSymbol;
        assert.match(quoteSymbol, /^[a-zA-Z]+$/, "Invalid symbol");
        const shareSymbolPrefix: string = args.shareSymbolPrefix;
        assert.match(shareSymbolPrefix, /^[a-zA-Z.]+$/, "Invalid symbol prefix");
        assert.ok(shareSymbolPrefix.length <= 5, "Symbol prefix too long");

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const twapOracleAddresses = loadAddressFile<TwapOracleAddresses>(
            hre,
            `twap_oracle_${underlyingSymbol.toLowerCase()}`
        );
        const bscAprOracleAddresses = loadAddressFile<BscAprOracleAddresses>(
            hre,
            `bsc_apr_oracle_${quoteSymbol.toLowerCase()}`
        );
        const feeDistributorAddresses = loadAddressFile<FeeDistrubtorAddresses>(
            hre,
            `fee_distributor_${underlyingSymbol.toLowerCase()}`
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
        const fundInitializationParams = args.fundInitializationParams
            ? JSON.parse(args.fundInitializationParams)
            : {};
        const fundNewSplitRatio = parseEther(fundInitializationParams.newSplitRatio || "500");
        const fundLastNavB = parseEther(fundInitializationParams.lastNavB || "1");
        const fundLastNavR = parseEther(fundInitializationParams.lastNavR || "1");

        const [deployer] = await ethers.getSigners();

        // +0 ShareQ
        // +1 ShareB
        // +2 ShareR
        // +3 Fund
        // +4 PrimaryMarket
        // +5 Strategy
        const fundAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 3,
        });
        const primaryMarketAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 4,
        });
        let strategyAddress = ethers.constants.AddressZero;
        if (strategyName !== "NONE") {
            strategyAddress = ethers.utils.getContractAddress({
                from: deployer.address,
                nonce: (await deployer.getTransactionCount("pending")) + 5,
            });
        }

        const Share = await ethers.getContractFactory("ShareV2");
        const shareQ = await Share.deploy(
            `Tranchess ${underlyingSymbol} QUEEN`,
            `${shareSymbolPrefix}QUEEN`,
            fundAddress,
            0
        );
        console.log(`ShareQ: ${shareQ.address}`);

        const shareB = await Share.deploy(
            `Tranchess ${underlyingSymbol} BISHOP`,
            `${shareSymbolPrefix}BISHOP`,
            fundAddress,
            1
        );
        console.log(`ShareB: ${shareB.address}`);

        const shareR = await Share.deploy(
            `Tranchess ${underlyingSymbol} ROOK`,
            `${shareSymbolPrefix}ROOK`,
            fundAddress,
            2
        );
        console.log(`ShareR: ${shareR.address}`);

        const Fund = await ethers.getContractFactory("FundV3");
        const UPPER_REBALANCE_THRESHOLD = parseEther("2");
        const LOWER_REBALANCE_THRESHOLD = parseEther("0.5");
        const fund = await Fund.deploy([
            underlyingToken.address,
            underlyingDecimals,
            shareQ.address,
            shareB.address,
            shareR.address,
            primaryMarketAddress,
            strategyAddress,
            0,
            UPPER_REBALANCE_THRESHOLD,
            LOWER_REBALANCE_THRESHOLD,
            twapOracleAddresses.twapOracle,
            bscAprOracleAddresses.bscAprOracle,
            governanceAddresses.interestRateBallot,
            feeDistributorAddresses.feeDistributor,
            { gasLimit: 5e6 }, // Gas estimation may fail
        ]);
        assert.strictEqual(fund.address, fundAddress);
        console.log(`Fund: ${fund.address}`);
        console.log(
            "Before setting protocol fee rate, make sure people have synced in FeeDistributor"
        );

        const redemptionFeeRate = parseEther(args.redemptionFeeRate);
        const mergeFeeRate = parseEther(args.mergeFeeRate);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
        const primaryMarket = await PrimaryMarket.deploy(
            fund.address,
            redemptionFeeRate,
            mergeFeeRate,
            fundCap,
            { gasLimit: 5e6 } // Gas estimation may fail
        );
        assert.strictEqual(primaryMarket.address, primaryMarketAddress);
        console.log(`PrimaryMarket: ${primaryMarket.address}`);

        if (strategyName !== "NONE") {
            console.log("Deploying strategy");
            await hre.run(`deploy_${strategyName}`, { ...strategyParams, fund: fund.address });
            const strategyAddresses = loadAddressFile<StrategyAddresses>(hre, strategyName);
            assert.strictEqual(strategyAddresses.strategy, strategyAddress);
        }

        const ShareStaking = await ethers.getContractFactory("ShareStaking");
        const shareStaking = await ShareStaking.deploy(
            fund.address,
            governanceAddresses.chessSchedule,
            governanceAddresses.chessController,
            governanceAddresses.votingEscrow,
            0
        );
        console.log(`ShareStaking: ${shareStaking.address}`);

        const PrimaryMarketRouter = await ethers.getContractFactory("PrimaryMarketRouter");
        const primaryMarketRouter = await PrimaryMarketRouter.deploy(primaryMarket.address);
        console.log(`PrimaryMarketRouter: ${primaryMarketRouter.address}`);

        if (args.fundInitializationParams) {
            console.log(
                `Initializing fund with ${fundNewSplitRatio}, ${fundLastNavB}, ${fundLastNavR}`
            );
            await fund.initialize(fundNewSplitRatio, fundLastNavB, fundLastNavR);
        } else {
            console.log("NOTE: Please call fund.initialize()");
        }

        console.log("Transfering ownership to TimelockController");
        await primaryMarket.transferOwnership(governanceAddresses.timelockController);
        await fund.transferOwnership(governanceAddresses.timelockController);

        const controllerBallot = await ethers.getContractAt(
            "ControllerBallot",
            governanceAddresses.controllerBallot
        );
        if ((await controllerBallot.owner()) === (await controllerBallot.signer.getAddress())) {
            console.log("Adding ShareStaking to ControllerBallot");
            await controllerBallot.addPool(shareStaking.address);
            console.log("NOTE: Please transfer ownership of ControllerBallot to Timelock later");
        } else {
            console.log("NOTE: Please add ShareStaking to ControllerBallot");
        }

        const addresses: FundAddresses = {
            ...newAddresses(hre),
            underlyingSymbol,
            underlying: underlyingToken.address,
            quoteSymbol,
            quote: quoteToken.address,
            twapOracle: twapOracleAddresses.twapOracle,
            aprOracle: bscAprOracleAddresses.bscAprOracle,
            feeDistributor: feeDistributorAddresses.feeDistributor,
            fund: fund.address,
            shareQ: shareQ.address,
            shareB: shareB.address,
            shareR: shareR.address,
            primaryMarket: primaryMarket.address,
            primaryMarketRouter: primaryMarketRouter.address,
            shareStaking: shareStaking.address,
        };
        saveAddressFile(hre, `fund_${underlyingSymbol.toLowerCase()}`, addresses);
    });
