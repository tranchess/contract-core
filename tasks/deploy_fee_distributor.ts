import { task } from "hardhat/config";
import { createAddressFile, selectAddressFile } from "./address_file";
import { updateHreSigner } from "./signers";

task("deploy_fee_distributor", "Deploy FeeDistributor")
    .addOptionalParam("governance", "Path to the governance address file", "")
    .addOptionalParam("fund", "Path to the fund address file", "")
    .addParam("admin", "Admin address")
    .addParam("adminFeeRate", "Admin fee rate")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;

        await hre.run("compile");
        const addressFile = createAddressFile(hre, "fee_distributor");
        const governanceAddresses = await selectAddressFile(hre, "governance", args.governance);
        const fundAddresses = await selectAddressFile(hre, "fund", args.fund);

        const adminFeeRate = parseEther(args.adminFeeRate);
        const FeeDistributor = await ethers.getContractFactory("FeeDistributor");
        const feeDistributor = await FeeDistributor.deploy(
            fundAddresses.underlying,
            governanceAddresses.votingEscrow,
            args.admin,
            adminFeeRate
        );
        console.log(`FeeDistributor: ${feeDistributor.address}`);
        addressFile.set("feeDistributor", feeDistributor.address);

        console.log("Transfering ownership to TimelockController");
        await feeDistributor.transferOwnership(governanceAddresses.timelockController);
    });
