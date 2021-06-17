import { task } from "hardhat/config";
import { createAddressFile } from "./address_file";
import { TWAP_ORACLE_CONFIG, APR_ORACLE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

task("deploy_oracle", "Deploy oracle contracts", async (_args, hre) => {
    await updateHreSigner(hre);
    const { ethers } = hre;

    await hre.run("compile");
    const addressFile = createAddressFile(hre, "oracle");

    const TwapOracle = await ethers.getContractFactory("TwapOracle");
    const twapOracle = await TwapOracle.deploy(
        TWAP_ORACLE_CONFIG.PRIMARY_SOURCE,
        TWAP_ORACLE_CONFIG.SECONDARY_SOURCE,
        TWAP_ORACLE_CONFIG.SYMBOL
    );
    console.log(`TwapOracle: ${twapOracle.address}`);
    addressFile.set("twapOracle", twapOracle.address);

    if (APR_ORACLE_CONFIG.V_TOKEN) {
        const AprOracle = await ethers.getContractFactory("BscAprOracle");
        const aprOracle = await AprOracle.deploy("USDC", APR_ORACLE_CONFIG.V_TOKEN);
        console.log(`AprOracle: ${aprOracle.address}`);
        addressFile.set("aprOracle", aprOracle.address);
    }
});
