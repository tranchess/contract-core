import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { FundAddresses } from "./deploy_fund";
import { GOVERNANCE_CONFIG, FUND_CONFIG, EXCHANGE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface ExchangeImplAddresses extends Addresses {
    underlyingSymbol: string;
    quoteSymbol: string;
    fund: string;
    exchangeImpl: string;
}

task("deploy_exchange_impl", "Deploy Exchange implementation contract")
    .addParam("underlyingSymbol", "Underlying token symbol of the fund")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const underlyingSymbol: string = args.underlyingSymbol;
        assert.match(underlyingSymbol, /^[a-zA-Z]+$/, "Invalid symbol");

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        console.log("Please choose the old fund");
        const oldFundAddresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${underlyingSymbol.toLowerCase()}`,
            true
        );
        console.log("Please choose the new fund");
        const newFundAddresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${underlyingSymbol.toLowerCase()}`,
            true
        );

        const fund = await ethers.getContractAt("Fund", oldFundAddresses.fund);
        const underlyingToken = await ethers.getContractAt("ERC20", await fund.tokenUnderlying());
        assert.strictEqual(underlyingSymbol, await underlyingToken.symbol());
        const quoteToken = await ethers.getContractAt("ERC20", oldFundAddresses.quote);
        const quoteSymbol: string = await quoteToken.symbol();
        const quoteDecimals = await quoteToken.decimals();
        const Exchange = await ethers.getContractFactory("ExchangeV3");
        const exchangeImpl = await Exchange.deploy(
            fund.address,
            governanceAddresses.chessSchedule,
            governanceAddresses.chessController,
            quoteToken.address,
            quoteDecimals,
            governanceAddresses.votingEscrow,
            parseEther(EXCHANGE_CONFIG.MIN_ORDER_AMOUNT),
            parseEther(EXCHANGE_CONFIG.MIN_ORDER_AMOUNT),
            FUND_CONFIG.GUARDED_LAUNCH ? GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP : 0,
            parseEther(EXCHANGE_CONFIG.GUARDED_LAUNCH_MIN_ORDER_AMOUNT),
            newFundAddresses.upgradeTool
        );
        console.log(`Exchange implementation: ${exchangeImpl.address}`);

        console.log("Making Exchange implementation unusable without proxy");
        await exchangeImpl.initialize();

        const addresses: ExchangeImplAddresses = {
            ...newAddresses(hre),
            underlyingSymbol,
            quoteSymbol,
            fund: fund.address,
            exchangeImpl: exchangeImpl.address,
        };
        saveAddressFile(hre, `exchange_v3_impl_${underlyingSymbol.toLowerCase()}`, addresses);
    });
