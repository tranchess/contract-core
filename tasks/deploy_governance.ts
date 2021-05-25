import { task } from "hardhat/config";
import { createAddressFile } from "./address_file";
import { GOVERNANCE_CONFIG } from "../config";

task("deploy_governance", "Deploy governance contracts", async function (_args, hre) {
    const { ethers } = hre;
    const { BigNumber } = ethers;
    const { parseEther } = ethers.utils;

    await hre.run("compile");
    const [deployer] = await ethers.getSigners();
    const addressFile = createAddressFile(hre, "governance");

    const TransparentUpgradeableProxy = await ethers.getContractFactory(
        "TransparentUpgradeableProxy"
    );
    const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
    const proxyAdmin = await ProxyAdmin.deploy();
    console.log(`ProxyAdmin: ${proxyAdmin.address}`);
    addressFile.set("proxyAdmin", proxyAdmin.address);

    const Chess = await ethers.getContractFactory("Chess");
    const chess = await Chess.deploy(parseEther(GOVERNANCE_CONFIG.CHESS_TOTAL_SUPPLY));
    console.log(`Chess: ${chess.address}`);
    addressFile.set("chess", chess.address);

    const ChessSchedule = await ethers.getContractFactory("ChessSchedule");
    const chessScheduleImpl = await ChessSchedule.deploy(
        chess.address,
        GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP
    );
    console.log(`ChessSchedule implementation: ${chessScheduleImpl.address}`);
    addressFile.set("chessScheduleImpl", chessScheduleImpl.address);

    // Predict address of ChessSchedule proxy and approve CHESS to it.
    const chessScheduleAddr = ethers.utils.getContractAddress({
        from: deployer.address,
        nonce: (await deployer.getTransactionCount("pending")) + 1,
    });
    await chess.approve(chessScheduleAddr, parseEther(GOVERNANCE_CONFIG.CHESS_SCHEDULE_MAX_SUPPLY));

    const initTx = await chessScheduleImpl.populateTransaction.initialize();
    const chessScheduleProxy = await TransparentUpgradeableProxy.deploy(
        chessScheduleImpl.address,
        proxyAdmin.address,
        initTx.data,
        { gasLimit: 1e6 } // Gas estimation may fail
    );
    const chessSchedule = ChessSchedule.attach(chessScheduleProxy.address);
    console.log(`ChessSchedule: ${chessSchedule.address}`);
    addressFile.set("chessSchedule", chessSchedule.address);

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
    const chessControllerImpl = await ChessController.deploy();
    console.log(`ChessController implementation: ${chessControllerImpl.address}`);
    addressFile.set("chessControllerImpl", chessControllerImpl.address);

    const chessControllerProxy = await TransparentUpgradeableProxy.deploy(
        chessControllerImpl.address,
        proxyAdmin.address,
        "0x",
        { gasLimit: 1e6 } // Gas estimation may fail
    );
    const chessController = ChessController.attach(chessControllerProxy.address);
    console.log(`ChessController: ${chessController.address}`);
    addressFile.set("chessController", chessController.address);

    const TimelockController = await ethers.getContractFactory("TimelockController");
    const timelockController = await TimelockController.deploy(
        GOVERNANCE_CONFIG.TIMELOCK_DELAY,
        [deployer.address], // proposers
        [ethers.constants.AddressZero] // executor
    );
    console.log(`TimelockController: ${timelockController.address}`);
    addressFile.set("timelockController", timelockController.address);
});
