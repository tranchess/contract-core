import { task } from "hardhat/config";
import { createAddressFile } from "./address_file";

task("deploy_misc", "Deploy misc contracts", async function (args, hre) {
    const { ethers } = hre;

    await hre.run("compile");
    const addressFile = createAddressFile(hre, "misc");

    const ProtocolDataProvider = await ethers.getContractFactory("ProtocolDataProvider");
    const protocolDataProvider = await ProtocolDataProvider.deploy();
    console.log(`ProtocolDataProvider: ${protocolDataProvider.address}`);
    addressFile.set("protocolDataProvider", protocolDataProvider.address);
});
