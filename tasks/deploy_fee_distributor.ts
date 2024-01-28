import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";
import { waitForContract } from "./utils";

export interface FeeDistrubtorAddresses extends Addresses {
    underlying: string;
    underlyingSymbol: string;
    feeDistributor: string;
}

task("deploy_fee_distributor", "Deploy fund contracts")
    .addParam("underlying", "Underlying token address")
    .addParam("adminFeeRate", "Admin fraction in the fee distributor")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        const adminFeeRate = parseEther(args.adminFeeRate);

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const underlying = await ethers.getContractAt("ERC20", args.underlying);
        const underlyingSymbol = await underlying.symbol();

        const FeeDistributor = await ethers.getContractFactory("FeeDistributor");
        const feeDistributor = await FeeDistributor.deploy(
            underlying.address,
            governanceAddresses.votingEscrow,
            GOVERNANCE_CONFIG.TREASURY || (await FeeDistributor.signer.getAddress()), // admin
            adminFeeRate
        );
        console.log(`FeeDistributor: ${feeDistributor.address}`);
        await waitForContract(hre, feeDistributor.address);

        console.log("Transfering ownership to TimelockController");
        await (
            await feeDistributor.transferOwnership(governanceAddresses.timelockController)
        ).wait();

        const addresses: FeeDistrubtorAddresses = {
            ...newAddresses(hre),
            underlying: underlying.address,
            underlyingSymbol: underlyingSymbol,
            feeDistributor: feeDistributor.address,
        };
        saveAddressFile(hre, `fee_distributor_${underlyingSymbol.toLowerCase()}`, addresses);
    });
