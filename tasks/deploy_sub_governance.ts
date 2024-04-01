import { task } from "hardhat/config";
import { saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { VotingEscrowImplAddresses } from "./deploy_voting_escrow_impl";
import type { ControllerBallotAddresses } from "./deploy_controller_ballot";
import type { ChessControllerImplAddresses } from "./deploy_chess_controller_impl";
import type { ChessPoolAddresses } from "./deploy_chess_pool";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";
import { waitForContract } from "./utils";

task("deploy_sub_governance", "Deploy sub chain governance contracts")
    .addParam("mainLzChainId", "Main LayerZero chain ID")
    .addParam("mainChainRelayer", "ChessScheduleRelayer address on the main chain")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");
        const [deployer] = await ethers.getSigners();

        const mainLzChainId = parseInt(args.mainLzChainId);
        const mainChainRelayer = args.mainChainRelayer;

        const TimelockController = await ethers.getContractFactory("TimelockController");
        const timelockController = await TimelockController.deploy(
            GOVERNANCE_CONFIG.TIMELOCK_DELAY,
            [GOVERNANCE_CONFIG.TREASURY || deployer.address],
            [GOVERNANCE_CONFIG.TREASURY || deployer.address]
        );
        console.log(`TimelockController: ${timelockController.address}`);
        await waitForContract(hre, timelockController.address);

        const TransparentUpgradeableProxy = await ethers.getContractFactory(
            "TransparentUpgradeableProxy"
        );
        const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
        const proxyAdmin = await ProxyAdmin.deploy();
        console.log(`ProxyAdmin: ${proxyAdmin.address}`);
        await waitForContract(hre, proxyAdmin.address);

        const Chess = await ethers.getContractFactory("AnyswapChess");
        const chess = await Chess.deploy(
            "Tranchess DAO Token",
            "CHESS",
            parseEther(GOVERNANCE_CONFIG.CHESS_TOTAL_SUPPLY)
        );
        console.log(`Chess: ${chess.address}`);
        await waitForContract(hre, chess.address);

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
            208 * 7 * 86400
        );
        const votingEscrowProxy = await TransparentUpgradeableProxy.deploy(
            votingEscrowImpl.address,
            proxyAdmin.address,
            votingEscrowInitTx.data,
            { gasLimit: 2e6 } // Gas estimation may fail
        );
        const votingEscrow = VotingEscrow.attach(votingEscrowProxy.address);
        console.log(`VotingEscrow: ${votingEscrow.address}`);
        await waitForContract(hre, votingEscrowProxy.address);

        const InterestRateBallot = await ethers.getContractFactory("InterestRateBallotV3");
        const interestRateBallot = await InterestRateBallot.deploy(
            votingEscrow.address,
            { gasLimit: 2e6 } // Gas estimation may fail
        );
        console.log(`InterestRateBallot: ${interestRateBallot.address}`);
        await waitForContract(hre, interestRateBallot.address);

        await hre.run("deploy_controller_ballot", { votingEscrow: votingEscrow.address });
        const controllerBallotAddresses = loadAddressFile<ControllerBallotAddresses>(
            hre,
            "controller_ballot"
        );
        const ControllerBallot = await ethers.getContractFactory("ControllerBallotV2");
        const controllerBallot = ControllerBallot.attach(
            controllerBallotAddresses.controllerBallot
        );
        console.log(`ControllerBallot: ${controllerBallot.address}`);

        await hre.run("deploy_chess_controller_impl", {
            launchDate: new Date(GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP * 1000)
                .toISOString()
                .split("T")[0],
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
        await waitForContract(hre, chessControllerProxy.address);

        const ChessSubSchedule = await ethers.getContractFactory("ChessSubSchedule");
        const chessSubScheduleImpl = await ChessSubSchedule.deploy(
            mainLzChainId,
            controllerBallot.address,
            chessPool.address,
            GOVERNANCE_CONFIG.LZ_ENDPOINT
        );
        console.log(`ChessSubSchedule implementation: ${chessSubScheduleImpl.address}`);
        await waitForContract(hre, chessSubScheduleImpl.address);

        const initTx = await chessSubScheduleImpl.populateTransaction.initialize();
        const chessSubScheduleProxy = await TransparentUpgradeableProxy.deploy(
            chessSubScheduleImpl.address,
            proxyAdmin.address,
            initTx.data,
            { gasLimit: 1e6 } // Gas estimation may fail
        );
        const chessSubSchedule = ChessSubSchedule.attach(chessSubScheduleProxy.address);
        console.log(`ChessSubSchedule: ${chessSubSchedule.address}`);
        await waitForContract(hre, chessSubScheduleProxy.address);

        console.log("Set ChessSubSchedule's trusted remote address");
        await (
            await chessSubSchedule.setTrustedRemoteAddress(mainLzChainId, mainChainRelayer)
        ).wait();

        console.log("Set VotingEscrow, ChessSubSchedule to be CHESS minters");
        await (await chessPool.addMinter(votingEscrow.address)).wait();
        await (await chessPool.addMinter(chessSubSchedule.address)).wait();
        await (await chess.addMinter(timelockController.address)).wait();
        await (await chessPool.addMinter(timelockController.address)).wait();

        console.log("Transfering ownership to TimelockController");
        await (await chess.transferOwnership(timelockController.address)).wait();
        await (await proxyAdmin.transferOwnership(timelockController.address)).wait();
        await (await chessPool.transferOwnership(timelockController.address)).wait();
        await (await votingEscrow.transferOwnership(timelockController.address)).wait();

        const addresses: GovernanceAddresses = {
            ...newAddresses(hre),
            timelockController: timelockController.address,
            proxyAdmin: proxyAdmin.address,
            chess: chess.address,
            chessPool: chessPool.address,
            chessScheduleImpl: chessSubScheduleImpl.address,
            chessSchedule: chessSubSchedule.address,
            votingEscrowImpl: votingEscrowImpl.address,
            votingEscrow: votingEscrow.address,
            interestRateBallot: interestRateBallot.address,
            controllerBallot: controllerBallot.address,
            chessControllerImpl: chessControllerImpl.address,
            chessController: chessController.address,
        };
        saveAddressFile(hre, "governance", addresses);
    });
