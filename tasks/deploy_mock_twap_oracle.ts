import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, newAddresses } from "./address_file";
import { updateHreSigner } from "./signers";

export interface TwapOracleAddresses extends Addresses {
    token: string;
    oracleSymbol: string;
    twapOracle: string;
}

task("deploy_mock_twap_oracle", "Deploy TwapOracle")
    .addParam("token", "Token contract address")
    .addParam("oracleSymbol", "Symbol in the oracle contract")
    .addParam("initialTwap", "The initial twap of the mock oracle")
    .setAction(async (args, hre) => {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const token = await ethers.getContractAt("ERC20", args.token);
        const tokenSymbol: string = await token.symbol();
        console.log("Token symbol:", tokenSymbol);
        const oracleSymbol: string = args.oracleSymbol;
        assert.match(oracleSymbol, /^[A-Z]+$/, "Invalid symbol");
        assert.ok(tokenSymbol.includes(oracleSymbol));

        const initialTwap = parseEther(args.initialTwap);

        const MockTwapOracle = await ethers.getContractFactory("MockTwapOracle");
        const mockTwapOracle = await MockTwapOracle.deploy(
            initialTwap,
            ethers.constants.AddressZero,
            0
        );
        console.log(`MockTwapOracle: ${mockTwapOracle.address}`);

        const addresses: TwapOracleAddresses = {
            ...newAddresses(hre),
            token: token.address,
            oracleSymbol,
            twapOracle: mockTwapOracle.address,
        };
        saveAddressFile(hre, `twap_oracle_${tokenSymbol.toLowerCase()}`, addresses);
    });
