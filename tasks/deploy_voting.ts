import { task } from "hardhat/config";
import { createAddressFile, selectAddressFile } from "./address_file";
import { updateHreSigner } from "./signers";

task("deploy_voting", "One-time job to deploy the new voting escrow", async function (_args, hre) {
    await updateHreSigner(hre);
    const { ethers } = hre;

    await hre.run("compile");
    const oldAddresses = await selectAddressFile(hre, "governance", "");
    const addressFile = createAddressFile(hre, "governance");

    const TransparentUpgradeableProxy = await ethers.getContractFactory(
        "TransparentUpgradeableProxy"
    );

    const VotingEscrow = await ethers.getContractFactory("VotingEscrow");
    const votingEscrowImpl = await VotingEscrow.deploy(
        oldAddresses.chess,
        ethers.constants.AddressZero,
        "Vote-escrowed CHESS",
        "veCHESS",
        208 * 7 * 86400 // 208 weeks
    );
    console.log(`VotingEscrow implementation: ${votingEscrowImpl.address}`);
    addressFile.set("votingEscrowImpl", votingEscrowImpl.address);

    const votingEscrowInitTx = await votingEscrowImpl.populateTransaction.initialize(
        26 * 7 * 86400
    );
    const votingEscrowProxy = await TransparentUpgradeableProxy.deploy(
        votingEscrowImpl.address,
        oldAddresses.proxyAdmin,
        votingEscrowInitTx.data,
        { gasLimit: 1e6 } // Gas estimation may fail
    );
    const votingEscrow = VotingEscrow.attach(votingEscrowProxy.address);
    console.log(`VotingEscrow: ${votingEscrow.address}`);
    addressFile.set("votingEscrow", votingEscrow.address);

    const InterestRateBallot = await ethers.getContractFactory("InterestRateBallot");
    const interestRateBallot = await InterestRateBallot.deploy(
        votingEscrow.address,
        { gasLimit: 2e6 } // Gas estimation may fail
    );
    console.log(`InterestRateBallot: ${interestRateBallot.address}`);
    addressFile.set("interestRateBallot", interestRateBallot.address);

    console.log("Transfering ownership to TimelockController");
    await votingEscrow.transferOwnership(oldAddresses.timelockController);
});
