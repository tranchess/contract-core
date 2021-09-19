import { task } from "hardhat/config";
import { createAddressFile } from "./address_file";
import { updateHreSigner } from "./signers";

task("deploy_address_whitelist", "Deploy AddressWhitelist")
    .addParam("addresses", "Comma-separated addresses")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;

        await hre.run("compile");
        const addressFile = createAddressFile(hre, "address_whitelist");

        const AddressWhitelist = await ethers.getContractFactory("AddressWhitelist");
        const addressWhitelist = await AddressWhitelist.deploy(args.addresses.split(","));
        console.log(`AddressWhitelist: ${addressWhitelist.address}`);
        addressFile.set("addressWhitelist", addressWhitelist.address);
    });
