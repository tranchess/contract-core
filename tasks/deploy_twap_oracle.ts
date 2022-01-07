import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, newAddresses } from "./address_file";
import { TWAP_ORACLE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface TwapOracleAddresses extends Addresses {
    token: string;
    oracleSymbol: string;
    twapOracle: string;
}

task("deploy_twap_oracle", "Deploy TwapOracle")
    .addParam("token", "Token contract address")
    .addParam("oracleSymbol", "Symbol in the oracle contract")
    .setAction(async (args, hre) => {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const token = await ethers.getContractAt("ERC20", args.token);
        const tokenSymbol: string = await token.symbol();
        console.log("Token symbol:", tokenSymbol);
        const oracleSymbol: string = args.oracleSymbol;
        assert.match(oracleSymbol, /^[A-Z]+$/, "Invalid symbol");
        assert.ok(tokenSymbol.includes(oracleSymbol));

        const TwapOracle = await ethers.getContractFactory("TwapOracle");
        const twapOracle = await TwapOracle.deploy(
            TWAP_ORACLE_CONFIG.PRIMARY_SOURCE,
            TWAP_ORACLE_CONFIG.SECONDARY_SOURCE,
            oracleSymbol
        );
        console.log(`TwapOracle: ${twapOracle.address}`);

        const addresses: TwapOracleAddresses = {
            ...newAddresses(hre),
            token: token.address,
            oracleSymbol,
            twapOracle: twapOracle.address,
        };
        saveAddressFile(hre, `twap_oracle_${tokenSymbol.toLowerCase()}`, addresses);
    });
