import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { createAddressFile, selectAddressFile } from "./address_file";
import { GOVERNANCE_CONFIG, FUND_CONFIG, EXCHANGE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

task("deploy_impl", "Deploy implementation contracts interactively")
    .addOptionalParam("governance", "Path to the governance address file", "")
    .addOptionalParam("fund", "Path to the fund address file", "")
    .addFlag("silent", "Run non-interactively and only deploy contracts specified by --deploy-*")
    .addFlag("deployChessSchedule", "Deploy ChessSchedule without prompt")
    .addFlag("deployVotingEscrow", "Deploy VotingEscrow without prompt")
    .addFlag("deployExchange", "Deploy Exchange without prompt")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;

        await hre.run("compile");
        const addressFile = createAddressFile(hre, "impl");
        const governanceAddresses = await selectAddressFile(hre, "governance", args.governance);
        const fundAddresses = await selectAddressFile(hre, "fund", args.governance);

        if (
            args.deployChessSchedule ||
            (!args.silent && keyInYNStrict("Deploy ChessSchedule implementation?", { guide: true }))
        ) {
            const ChessSchedule = await ethers.getContractFactory("ChessSchedule");
            const chessScheduleImpl = await ChessSchedule.deploy(
                governanceAddresses.chess,
                GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP
            );
            console.log(`ChessSchedule implementation: ${chessScheduleImpl.address}`);
            addressFile.set("chessScheduleImpl", chessScheduleImpl.address);
        }
        if (
            args.deployVotingEscrow ||
            (!args.silent && keyInYNStrict("Deploy VotingEscrow implementation?", { guide: true }))
        ) {
            const VotingEscrow = await ethers.getContractFactory("VotingEscrowV2");
            const votingEscrowImpl = await VotingEscrow.deploy(
                governanceAddresses.chess,
                208 * 7 * 86400 // 208 weeks
            );
            console.log(`VotingEscrow implementation: ${votingEscrowImpl.address}`);
            addressFile.set("votingEscrowImpl", votingEscrowImpl.address);

            console.log("Making VotingEscrow implementation unusable without proxy");
            await (await votingEscrowImpl.initialize("", "", 0)).wait();
            await votingEscrowImpl.renounceOwnership();
        }
        if (
            args.deployExchange ||
            (!args.silent && keyInYNStrict("Deploy Exchange implementation?", { guide: true }))
        ) {
            const quoteToken = await ethers.getContractAt("ERC20", EXCHANGE_CONFIG.QUOTE_ADDRESS);
            const quoteDecimals = await quoteToken.decimals();
            const Exchange = await ethers.getContractFactory("ExchangeV2");
            const exchangeImpl = await Exchange.deploy(
                fundAddresses.fund,
                governanceAddresses.chessSchedule,
                governanceAddresses.chessController,
                quoteToken.address,
                quoteDecimals,
                governanceAddresses.votingEscrow,
                parseEther(EXCHANGE_CONFIG.MIN_ORDER_AMOUNT),
                parseEther(EXCHANGE_CONFIG.MIN_ORDER_AMOUNT),
                parseEther(EXCHANGE_CONFIG.MAKER_REQUIREMENT),
                FUND_CONFIG.GUARDED_LAUNCH ? GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP : 0,
                parseEther(EXCHANGE_CONFIG.GUARDED_LAUNCH_MIN_ORDER_AMOUNT)
            );
            console.log(`Exchange implementation: ${exchangeImpl.address}`);
            addressFile.set("exchangeImpl", exchangeImpl.address);
        }
    });
