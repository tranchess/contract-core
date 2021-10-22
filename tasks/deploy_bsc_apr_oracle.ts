import { task } from "hardhat/config";
import { Addresses, saveAddressFile, newAddresses } from "./address_file";
import { updateHreSigner } from "./signers";

export interface BscAprOracleAddresses extends Addresses {
    token: string;
    vToken: string;
    bscAprOracle: string;
}

task("deploy_bsc_apr_oracle", "Deploy BscAprOracle")
    .addParam("token", "Token contract address")
    .addParam("vToken", "VToken contract address")
    .setAction(async (args, hre) => {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const token = await ethers.getContractAt("ERC20", args.token);
        const tokenSymbol: string = await token.symbol();
        console.log("Token symbol:", tokenSymbol);
        const vToken: string = args.vToken;
        console.log("VToken:", vToken);

        const BscAprOracle = await ethers.getContractFactory("BscAprOracle");
        const bscAprOracle = await BscAprOracle.deploy(tokenSymbol, vToken);
        console.log(`BscAprOracle: ${bscAprOracle.address}`);

        const addresses: BscAprOracleAddresses = {
            ...newAddresses(hre),
            token: token.address,
            vToken,
            bscAprOracle: bscAprOracle.address,
        };
        saveAddressFile(hre, `bsc_apr_oracle_${tokenSymbol.toLowerCase()}`, addresses);
    });
