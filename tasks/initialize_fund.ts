import { task } from "hardhat/config";
import { selectAddressFile } from "./address_file";

task("initialize_fund", "Initialize fund")
    .addOptionalParam("governance", "Path to the governance address file", "")
    .addOptionalParam("fund", "Path to the fund address file", "")
    .setAction(async function (args, hre) {
        const { ethers } = hre;

        const [deployer] = await ethers.getSigners();
        const governanceAddresses = await selectAddressFile("governance", args.governance);
        const fundAddresses = await selectAddressFile("fund", args.fund);

        const fund = await ethers.getContractAt("Fund", fundAddresses.fund);
        const underlying = await ethers.getContractAt("ERC20", fundAddresses.underlying);
        const underlyingDecimals = await underlying.decimals();

        console.log("Initializing Fund");
        await fund.initialize(
            fundAddresses.underlying,
            underlyingDecimals,
            fundAddresses.shareM,
            fundAddresses.shareA,
            fundAddresses.shareB,
            fundAddresses.aprOracle,
            governanceAddresses.interestRateBallot,
            fundAddresses.primaryMarket,
            deployer.address // FIXME read from configuration
        );
    });
