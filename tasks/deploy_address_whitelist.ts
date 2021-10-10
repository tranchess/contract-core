import { task } from "hardhat/config";
import { Addresses, saveAddressFile, newAddresses } from "./address_file";
import { updateHreSigner } from "./signers";

export interface AddressWhitelistAddresses extends Addresses {
    addressWhitelist: string;
}

task("deploy_address_whitelist", "Deploy AddressWhitelist")
    .addParam("whitelist", "Comma-separated addresses")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const AddressWhitelist = await ethers.getContractFactory("AddressWhitelist");
        const addressWhitelist = await AddressWhitelist.deploy(args.whitelist.split(","));
        console.log(`AddressWhitelist: ${addressWhitelist.address}`);

        const addresses: AddressWhitelistAddresses = {
            ...newAddresses(hre),
            addressWhitelist: addressWhitelist.address,
        };
        saveAddressFile(hre, "address_whitelist", addresses);
    });
