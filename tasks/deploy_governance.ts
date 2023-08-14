import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { ChessScheduleImplAddresses } from "./deploy_chess_schedule_impl";
import type { VotingEscrowImplAddresses } from "./deploy_voting_escrow_impl";
import type { ControllerBallotAddresses } from "./deploy_controller_ballot";
import type { ChessControllerImplAddresses } from "./deploy_chess_controller_impl";
import type { ChessPoolAddresses } from "./deploy_chess_pool";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface GovernanceAddresses extends Addresses {
    timelockController: string;
    proxyAdmin: string;
    chess: string;
    chessPool: string;
    chessScheduleImpl: string;
    chessSchedule: string;
    votingEscrowImpl: string;
    votingEscrow: string;
    interestRateBallot: string;
    controllerBallot: string;
    chessControllerImpl: string;
    chessController: string;
}

task("deploy_governance", "Deploy governance contracts", async function (_args, hre) {
    await updateHreSigner(hre);
    const { ethers } = hre;
    const { parseEther } = ethers.utils;
    await hre.run("compile");
    const [deployer] = await ethers.getSigners();

    const TimelockController = await ethers.getContractFactory("TimelockController");
    const timelockController = await TimelockController.deploy(
        GOVERNANCE_CONFIG.TIMELOCK_DELAY,
        [GOVERNANCE_CONFIG.TREASURY || deployer.address],
        [GOVERNANCE_CONFIG.TREASURY || deployer.address]
    );
    console.log(`TimelockController: ${timelockController.address}`);

    const TransparentUpgradeableProxy = await ethers.getContractFactory(
        "TransparentUpgradeableProxy"
    );
    const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
    const proxyAdmin = await ProxyAdmin.deploy();
    console.log(`ProxyAdmin: ${proxyAdmin.address}`);

    const Chess = await ethers.getContractFactory("Chess");
    const chess = await Chess.deploy(parseEther(GOVERNANCE_CONFIG.CHESS_TOTAL_SUPPLY));
    console.log(`Chess: ${chess.address}`);

    await hre.run("deploy_chess_schedule_impl", { chess: chess.address });
    const chessScheduleImplAddresses = loadAddressFile<ChessScheduleImplAddresses>(
        hre,
        "chess_schedule_impl"
    );
    const ChessSchedule = await ethers.getContractFactory("ChessSchedule");
    const chessScheduleImpl = ChessSchedule.attach(chessScheduleImplAddresses.chessScheduleImpl);

    // Predict address of ChessSchedule proxy and approve CHESS to it.
    const chessScheduleAddr = ethers.utils.getContractAddress({
        from: deployer.address,
        nonce: (await deployer.getTransactionCount("pending")) + 1,
    });
    await (
        await chess.approve(
            chessScheduleAddr,
            parseEther(GOVERNANCE_CONFIG.CHESS_SCHEDULE_MAX_SUPPLY)
        )
    ).wait();

    const initTx = await chessScheduleImpl.populateTransaction.initialize();
    const chessScheduleProxy = await TransparentUpgradeableProxy.deploy(
        chessScheduleImpl.address,
        proxyAdmin.address,
        initTx.data,
        { gasLimit: 1e6 } // Gas estimation may fail
    );
    const chessSchedule = ChessSchedule.attach(chessScheduleProxy.address);
    console.log(`ChessSchedule: ${chessSchedule.address}`);

    await hre.run("deploy_chess_pool", {
        chess: chess.address,
    });
    const chessPool = await ethers.getContractAt(
        "ProxyOFTPool",
        loadAddressFile<ChessPoolAddresses>(hre, "chess_pool").chessPool
    );
    console.log(`ChessPool: ${chessPool.address}`);

    await hre.run("deploy_voting_escrow_impl", {
        chess: chess.address,
        chessPool: chessPool.address,
    });
    const votingEscrowImplAddresses = loadAddressFile<VotingEscrowImplAddresses>(
        hre,
        "voting_escrow_v4_impl"
    );
    const VotingEscrow = await ethers.getContractFactory("VotingEscrowV4");
    const votingEscrowImpl = VotingEscrow.attach(votingEscrowImplAddresses.votingEscrowImpl);

    const votingEscrowInitTx = await votingEscrowImpl.populateTransaction.initialize(
        "Vote-escrowed CHESS",
        "veCHESS",
        26 * 7 * 86400
    );
    const votingEscrowProxy = await TransparentUpgradeableProxy.deploy(
        votingEscrowImpl.address,
        proxyAdmin.address,
        votingEscrowInitTx.data,
        { gasLimit: 2e6 } // Gas estimation may fail
    );
    const votingEscrow = VotingEscrow.attach(votingEscrowProxy.address);
    console.log(`VotingEscrow: ${votingEscrow.address}`);

    const InterestRateBallot = await ethers.getContractFactory("InterestRateBallotV2");
    const interestRateBallot = await InterestRateBallot.deploy(
        votingEscrow.address,
        { gasLimit: 2e6 } // Gas estimation may fail
    );
    console.log(`InterestRateBallot: ${interestRateBallot.address}`);

    await hre.run("deploy_controller_ballot", { votingEscrow: votingEscrow.address });
    const controllerBallotAddresses = loadAddressFile<ControllerBallotAddresses>(
        hre,
        "controller_ballot"
    );
    const ControllerBallot = await ethers.getContractFactory("ControllerBallotV2");
    const controllerBallot = ControllerBallot.attach(controllerBallotAddresses.controllerBallot);
    console.log(`ControllerBallot: ${controllerBallot.address}`);

    await hre.run("deploy_chess_controller_impl", {
        firstUnderlyingSymbol: "NONE",
        launchDate: new Date(GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP * 1000).toISOString().split("T")[0],
    });
    const chessControllerImplAddresses = loadAddressFile<ChessControllerImplAddresses>(
        hre,
        "chess_controller_v6_impl"
    );
    const ChessController = await ethers.getContractFactory("ChessControllerV6");
    const chessControllerImpl = ChessController.attach(
        chessControllerImplAddresses.chessControllerImpl
    );
    console.log(`ChessController implementation: ${chessControllerImpl.address}`);

    const initChessController = await chessControllerImpl.populateTransaction.initializeV4(
        GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP - 86400 * 7
    );
    const chessControllerProxy = await TransparentUpgradeableProxy.deploy(
        chessControllerImpl.address,
        proxyAdmin.address,
        initChessController.data,
        { gasLimit: 1e6 } // Gas estimation may fail
    );
    const chessController = ChessController.attach(chessControllerProxy.address);
    console.log(`ChessController: ${chessController.address}`);

    console.log("Set VotingEscrow to be CHESS minters");
    await chessPool.addMinter(votingEscrow.address);

    console.log("Transfering ownership to TimelockController");
    await proxyAdmin.transferOwnership(timelockController.address);
    await chessPool.transferOwnership(timelockController.address);
    await votingEscrow.transferOwnership(timelockController.address);

    const addresses: GovernanceAddresses = {
        ...newAddresses(hre),
        timelockController: timelockController.address,
        proxyAdmin: proxyAdmin.address,
        chess: chess.address,
        chessPool: chessPool.address,
        chessScheduleImpl: chessScheduleImpl.address,
        chessSchedule: chessSchedule.address,
        votingEscrowImpl: votingEscrowImpl.address,
        votingEscrow: votingEscrow.address,
        interestRateBallot: interestRateBallot.address,
        controllerBallot: controllerBallot.address,
        chessControllerImpl: chessControllerImpl.address,
        chessController: chessController.address,
    };
    saveAddressFile(hre, "governance", addresses);
});
