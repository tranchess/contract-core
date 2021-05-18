import { task } from "hardhat/config";
import { createAddressFile } from "./address_file";
import { GOVERNANCE_CONFIG } from "../config";

task("deploy_governance", "Deploy governance contracts", async function (_args, hre) {
    const { ethers } = hre;
    const { BigNumber } = ethers;

    await hre.run("compile");
    const [deployer] = await ethers.getSigners();
    const addressFile = createAddressFile(hre, "governance");

    const Chess = await ethers.getContractFactory("Chess");
    const chess = await Chess.deploy(GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP);
    console.log(`Chess: ${chess.address}`);
    addressFile.set("chess", chess.address);

    const VotingEscrow = await ethers.getContractFactory("VotingEscrow");
    const votingEscrow = await VotingEscrow.deploy(
        chess.address,
        ethers.constants.AddressZero,
        "Chess Vote",
        "veCHESS",
        BigNumber.from(4 * 365 * 86400)
    );
    console.log(`VotingEscrow: ${votingEscrow.address}`);
    addressFile.set("votingEscrow", votingEscrow.address);

    const InterestRateBallot = await ethers.getContractFactory("InterestRateBallot");
    const interestRateBallot = await InterestRateBallot.deploy(
        votingEscrow.address,
        { gasLimit: 2e6 } // Gas estimation may fail
    );
    console.log(`InterestRateBallot: ${interestRateBallot.address}`);
    addressFile.set("interestRateBallot", interestRateBallot.address);

    const ChessController = await ethers.getContractFactory("ChessController");
    const chessController = await ChessController.deploy();
    console.log(`ChessController: ${chessController.address}`);
    addressFile.set("chessController", chessController.address);

    const Timelock = await ethers.getContractFactory("Timelock");
    const timelock = await Timelock.deploy(
        GOVERNANCE_CONFIG.TIMELOCK_DELAY,
        [deployer.address], // proposers
        [ethers.constants.AddressZero] // executor
    );
    console.log(`Timelock: ${timelock.address}`);
    addressFile.set("timelock", timelock.address);
});
