import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { FundAddresses } from "./deploy_fund";
import type { ExchangeImplAddresses } from "./deploy_exchange_impl";
import { updateHreSigner } from "./signers";

export interface ExchangeAddresses extends Addresses {
    underlyingSymbol: string;
    quoteSymbol: string;
    fund: string;
    exchangeImpl: string;
    exchange: string;
}

task("deploy_exchange", "Deploy exchange contracts")
    .addParam("underlyingSymbol", "Underlying token symbol of the fund")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const underlyingSymbol: string = args.underlyingSymbol;
        assert.ok(underlyingSymbol.match(/[a-zA-Z]+/), "Invalid symbol");

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const fundAddresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${underlyingSymbol.toLowerCase()}`
        );

        await hre.run("deploy_exchange_impl", { underlyingSymbol });
        const exchangeImplAddresses = loadAddressFile<ExchangeImplAddresses>(
            hre,
            `exchange_v2_impl_${underlyingSymbol.toLowerCase()}`
        );
        assert.strictEqual(underlyingSymbol, exchangeImplAddresses.underlyingSymbol);
        assert.strictEqual(fundAddresses.quoteSymbol, exchangeImplAddresses.quoteSymbol);

        const Exchange = await ethers.getContractFactory("ExchangeV2");
        const exchangeImpl = Exchange.attach(exchangeImplAddresses.exchangeImpl);

        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const initTx = await exchangeImpl.populateTransaction.initialize();
        const exchangeProxy = await TransparentUpgradeableProxy.deploy(
            exchangeImpl.address,
            governanceAddresses.proxyAdmin,
            initTx.data,
            { gasLimit: 1e6 } // Gas estimation may fail
        );
        const exchange = Exchange.attach(exchangeProxy.address);
        console.log(`Exchange: ${exchange.address}`);

        const chessSchedule = await ethers.getContractAt(
            "ChessSchedule",
            governanceAddresses.chessSchedule
        );
        if ((await chessSchedule.owner()) === (await chessSchedule.signer.getAddress())) {
            await chessSchedule.addMinter(exchange.address);
            console.log("Exchange is a CHESS minter now");
            console.log("NOTE: Please transfer ownership of ChessSchedule to Timelock later");
        } else {
            console.log("NOTE: Please add Exchange as a minter of ChessSchedule");
        }

        const addresses: ExchangeAddresses = {
            ...newAddresses(hre),
            underlyingSymbol,
            quoteSymbol: fundAddresses.quoteSymbol,
            fund: fundAddresses.fund,
            exchangeImpl: exchangeImpl.address,
            exchange: exchange.address,
        };
        saveAddressFile(hre, `exchange_${underlyingSymbol.toLowerCase()}`, addresses);
    });
