import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { FeeDistrubtorAddresses } from "./deploy_fee_distributor";
import { updateHreSigner } from "./signers";
import { BigNumber } from "ethers";
import { waitForContract } from "./utils";

export interface FundAddresses extends Addresses {
    underlyingSymbol: string;
    underlying: string;
    twapOracle: string;
    aprOracle: string;
    feeConverter: string;
    feeDistributor: string;
    fund: string;
    shareQ: string;
    shareB: string;
    shareR: string;
    primaryMarket: string;
    primaryMarketRouter: string;
}

task("deploy_maturity_fund", "Deploy MaturityFund contracts")
    .addParam("underlying", "Underlying token address")
    .addParam("shareSymbols", "Symbols of share tokens")
    .addParam("maturityDays", "Maturity days")
    .addParam("redemptionFeeRate", "Primary market redemption fee rate")
    .addParam("mergeFeeRate", "Primary market merge fee rate")
    .addParam("bishopApr", "Initial annual interest rate")
    .addParam(
        "fundInitializationParams",
        "Parameters to call Fund.initialize() in JSON (param names in camelCase)",
        ""
    )
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const underlyingAddress = args.underlying;
        const underlyingToken = await ethers.getContractAt("ERC20", underlyingAddress);
        const underlyingDecimals = await underlyingToken.decimals();
        const underlyingSymbol: string = await underlyingToken.symbol();
        assert.match(underlyingSymbol, /^[a-zA-Z]+$/, "Invalid symbol");
        console.log(`Underlying: ${underlyingToken.address}`);

        const shareSymbols: string[] = args.shareSymbols.split(",").filter(Boolean);
        for (const symbol of shareSymbols) {
            assert.match(symbol, /^[a-zA-Z]+$/, "Invalid symbol");
        }
        assert.ok(shareSymbols.length == 3, "Share symbol count is not 3");

        const maturityDays = parseInt(args.maturityDays);
        assert.ok(maturityDays > 0 && maturityDays <= 365 * 10, "Invalid maturity days");

        const bishopApr = parseEther(args.bishopApr);
        assert.ok(bishopApr.lt(parseEther("1")) && bishopApr.gt(0), "Invalid bishop APR");

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const feeDistributorAddresses = loadAddressFile<FeeDistrubtorAddresses>(
            hre,
            `fee_distributor_${underlyingSymbol.toLowerCase()}`
        );

        const fundInitializationParams = JSON.parse(args.fundInitializationParams);
        const fundNewSplitRatio = parseEther(fundInitializationParams.newSplitRatio);
        const fundLastNavB = parseEther(fundInitializationParams.lastNavB || "1");
        const fundLastNavR = parseEther(fundInitializationParams.lastNavR || "1");

        const [deployer] = await ethers.getSigners();

        const ConstPriceOracle = await ethers.getContractFactory("ConstPriceOracle");
        const twapOracle = await ConstPriceOracle.deploy(parseEther("1"));
        console.log(`TwapOracle: ${twapOracle.address}`);
        await waitForContract(hre, twapOracle.address);

        const ConstAprOracle = await ethers.getContractFactory("ConstAprOracle");
        const aprOracle = await ConstAprOracle.deploy(bishopApr.div(365));
        console.log(`AprOracle: ${aprOracle.address}`);
        await waitForContract(hre, aprOracle.address);

        // +0 ShareQ
        // +1 ShareB
        // +2 ShareR
        // +3 Fund
        // +4 PrimaryMarket
        // +5 FeeConverter
        const fundAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 3,
        });
        const primaryMarketAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 4,
        });
        const feeConverterAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 5,
        });

        const Share = await ethers.getContractFactory("ShareV2");
        const shareQ = await Share.deploy(
            `Tranchess ${underlyingSymbol} QUEEN`,
            `${shareSymbols[0]}`,
            fundAddress,
            0
        );
        console.log(`ShareQ: ${shareQ.address}`);
        await waitForContract(hre, shareQ.address);

        const shareB = await Share.deploy(
            `Tranchess ${underlyingSymbol} stable YSTONE`,
            `${shareSymbols[1]}`,
            fundAddress,
            1
        );
        console.log(`ShareB: ${shareB.address}`);
        await waitForContract(hre, shareB.address);

        const shareR = await Share.deploy(
            `Tranchess ${underlyingSymbol} turbo YSTONE`,
            `${shareSymbols[2]}`,
            fundAddress,
            2
        );
        console.log(`ShareR: ${shareR.address}`);
        await waitForContract(hre, shareR.address);

        const Fund = await ethers.getContractFactory("MaturityFund");
        const fund = await Fund.deploy([
            9,
            86400 * maturityDays,
            underlyingToken.address,
            underlyingDecimals,
            shareQ.address,
            shareB.address,
            shareR.address,
            primaryMarketAddress,
            ethers.constants.AddressZero,
            twapOracle.address,
            aprOracle.address,
            feeConverterAddress,
            { gasLimit: 5e6 }, // Gas estimation may fail
        ]);
        assert.strictEqual(fund.address, fundAddress);
        console.log(`Fund: ${fund.address}`);
        await waitForContract(hre, fund.address);

        const redemptionFeeRate = parseEther(args.redemptionFeeRate);
        const mergeFeeRate = parseEther(args.mergeFeeRate);
        const PrimaryMarket = await ethers.getContractFactory("MaturityPrimaryMarket");
        const primaryMarket = await PrimaryMarket.deploy(
            fund.address,
            redemptionFeeRate,
            mergeFeeRate,
            BigNumber.from(1).shl(256).sub(1), // fund cap
            true, // redemption flag
            { gasLimit: 8e6 } // Gas estimation may fail
        );
        assert.strictEqual(primaryMarket.address, primaryMarketAddress);
        console.log(`PrimaryMarket: ${primaryMarket.address}`);
        await waitForContract(hre, primaryMarket.address);

        const FeeConverter = await ethers.getContractFactory("FeeConverter");
        const feeConverter = await FeeConverter.deploy(
            primaryMarketAddress,
            feeDistributorAddresses.feeDistributor
        );
        assert.strictEqual(feeConverter.address, feeConverterAddress);
        console.log(`FeeConverter: ${feeConverter.address}`);
        await waitForContract(hre, feeConverter.address);

        const PrimaryMarketRouter = await ethers.getContractFactory("PrimaryMarketRouterV2");
        const primaryMarketRouter = await PrimaryMarketRouter.deploy(primaryMarket.address);
        console.log(`PrimaryMarketRouter: ${primaryMarketRouter.address}`);
        await waitForContract(hre, primaryMarketRouter.address);

        console.log(
            `Initializing fund with ${fundNewSplitRatio}, ${fundLastNavB}, ${fundLastNavR}`
        );
        await (await fund.initialize(fundNewSplitRatio, fundLastNavB, fundLastNavR, 0)).wait();

        console.log("Transfering PrimaryMarket's ownership to TimelockController");
        await (
            await primaryMarket.transferOwnership(governanceAddresses.timelockController)
        ).wait();

        console.log("Transfering Fund's ownership to TimelockController");
        await (await fund.transferOwnership(governanceAddresses.timelockController)).wait();

        console.log("Transfering ConstAprOracle's ownership to TimelockController");
        await (await aprOracle.transferOwnership(governanceAddresses.timelockController)).wait();

        const addresses: FundAddresses = {
            ...newAddresses(hre),
            underlyingSymbol,
            underlying: underlyingToken.address,
            twapOracle: twapOracle.address,
            aprOracle: aprOracle.address,
            feeConverter: feeConverter.address,
            feeDistributor: feeDistributorAddresses.feeDistributor,
            fund: fund.address,
            shareQ: shareQ.address,
            shareB: shareB.address,
            shareR: shareR.address,
            primaryMarket: primaryMarket.address,
            primaryMarketRouter: primaryMarketRouter.address,
        };
        saveAddressFile(hre, `fund_${underlyingSymbol.toLowerCase()}`, addresses);
    });
