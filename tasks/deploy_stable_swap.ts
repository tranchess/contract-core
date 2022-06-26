import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { GOVERNANCE_CONFIG } from "../config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";
import { BigNumber, Contract } from "ethers";
import { FundAddresses } from "./deploy_fund";
import { FeeDistrubtorAddresses } from "./deploy_fee_distributor";

export interface StableSwapAddresses extends Addresses {
    kind: string;
    underlyingSymbol: string;
    base: string;
    baseSymbol: string;
    quote: string;
    quoteSymbol: string;
    bonus: string;
    bonusSymbol: string;
    feeDistributor: string;
    swapBonus: string;
    liquidityGauge: string;
    stableSwap: string;
}

task("deploy_stable_swap", "Deploy stable swap contracts")
    .addParam("kind", "Queen or Bishop stable swap")
    .addParam("underlyingSymbol", "Underlying token symbol of the swap")
    .addParam("quote", "Quote token address")
    .addParam("bonus", "Bonus token address")
    .addParam("ampl", "The ampl of the swap")
    .addParam("feeRate", "The fee rate of the swap")
    .addParam("adminFeeRate", "The admin fee rate of the swap")
    .addOptionalParam(
        "tradingCurbThreshold",
        "The tradingCurbThreshold of the swap (only for Bishop)"
    )
    .addOptionalParam(
        "rewardStartTimestamp",
        "The reward start timestamp of the LP (only for Bishop)"
    )
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        assert.match(args.kind, /^Queen|Bishop$/, "Invalid kind");
        const kind: "Queen" | "Bishop" = args.kind;

        const underlyingSymbol: string = args.underlyingSymbol;
        assert.match(underlyingSymbol, /^[a-zA-Z]+$/, "Invalid symbol");

        const quote = await ethers.getContractAt("ERC20", args.quote);
        const quoteSymbol = await quote.symbol();
        const quoteDecimals = await quote.decimals();

        const bonus = await ethers.getContractAt("ERC20", args.bonus);
        const bonusSymbol = await bonus.symbol();

        const fundAddresses = loadAddressFile<FundAddresses>(
            hre,
            `fund_${underlyingSymbol.toLowerCase()}`
        );
        const feeDistributorAddresses = loadAddressFile<FeeDistrubtorAddresses>(
            hre,
            `fee_distributor_${quoteSymbol.toLowerCase()}`
        );
        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        let base: Contract;
        switch (kind) {
            case "Queen": {
                base = await ethers.getContractAt("ERC20", fundAddresses.shareQ);
                break;
            }
            case "Bishop": {
                base = await ethers.getContractAt("ERC20", fundAddresses.shareB);
                break;
            }
        }
        const baseSymbol = await base.symbol();

        const ampl = BigNumber.from(args.ampl);
        const feeRate = parseEther(args.feeRate);
        const adminFeeRate = parseEther(args.adminFeeRate);
        const tradingCurbThreshold = parseEther(args.tradingCurbThreshold || "0");
        const rewardStartTimestamp = Number(args.rewardStartTimestamp || "0");

        const [deployer] = await ethers.getSigners();

        // +0 SwapBonus
        // +1 StableSwap
        // +2 LiquidityGauge
        const liquidityGaugeAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 2,
        });

        console.log(
            `Deploying ${kind}StableSwap between ${baseSymbol}-${quoteSymbol} (Bonus: ${bonusSymbol}).`
        );

        const SwapBonus = await ethers.getContractFactory("SwapBonus");
        const swapBonus = await SwapBonus.deploy(liquidityGaugeAddress, bonus.address);
        console.log(`SwapBonus: ${swapBonus.address}`);

        let stableSwap: Contract;
        switch (kind) {
            case "Queen": {
                const QueenStableSwap = await ethers.getContractFactory("QueenStableSwap");
                stableSwap = await QueenStableSwap.deploy(
                    liquidityGaugeAddress,
                    fundAddresses.fund,
                    quoteDecimals,
                    ampl,
                    feeDistributorAddresses.feeDistributor,
                    feeRate,
                    adminFeeRate
                );
                break;
            }
            case "Bishop": {
                const BishopStableSwap = await ethers.getContractFactory("BishopStableSwap");
                stableSwap = await BishopStableSwap.deploy(
                    liquidityGaugeAddress,
                    fundAddresses.fund,
                    quote.address,
                    quoteDecimals,
                    ampl,
                    feeDistributorAddresses.feeDistributor,
                    feeRate,
                    adminFeeRate,
                    tradingCurbThreshold
                );
                break;
            }
        }
        console.log(`StableSwap: ${stableSwap.address}`);

        const chessSchedule = await ethers.getContractAt(
            "ChessSchedule",
            governanceAddresses.chessSchedule
        );

        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const liquidityGauge = await LiquidityGauge.deploy(
            `Tranchess ${baseSymbol}-${quoteSymbol}`,
            `${baseSymbol}-LP`,
            stableSwap.address,
            chessSchedule.address,
            governanceAddresses.chessController,
            fundAddresses.fund,
            governanceAddresses.votingEscrow,
            swapBonus.address,
            rewardStartTimestamp
        );
        console.log(`LiquidityGauge: ${liquidityGauge.address}`);

        if (kind == "Bishop") {
            const controllerBallot = await ethers.getContractAt(
                "ControllerBallot",
                governanceAddresses.controllerBallot
            );
            if ((await controllerBallot.owner()) === (await controllerBallot.signer.getAddress())) {
                console.log("Adding LiquidityGauge to ControllerBallot");
                await controllerBallot.addPool(liquidityGauge.address);
                console.log(
                    "NOTE: Please transfer ownership of ControllerBallot to Timelock later"
                );
            } else {
                console.log("NOTE: Please add LiquidityGauge to ControllerBallot");
            }

            console.log("Please add LiquidityGauge to ChessSchedule");
        }

        console.log("Transfering StableSwap's ownership to TimelockController");
        await stableSwap.transferOwnership(governanceAddresses.timelockController);
        if (GOVERNANCE_CONFIG.TREASURY) {
            console.log("Transfering StableSwap's pauser and SwapBonus's ownership to treasury");
            await stableSwap.transferPauserRole(GOVERNANCE_CONFIG.TREASURY);
            await swapBonus.transferOwnership(GOVERNANCE_CONFIG.TREASURY);
        } else {
            console.log(
                "NOTE: Please transfer StableSwap's pauser and SwapBonus's ownership to treasury"
            );
        }

        const addresses: StableSwapAddresses = {
            ...newAddresses(hre),
            kind: kind,
            underlyingSymbol,
            base: base.address,
            baseSymbol: baseSymbol,
            quote: quote.address,
            quoteSymbol: quoteSymbol,
            bonus: bonus.address,
            bonusSymbol: bonusSymbol,
            feeDistributor: feeDistributorAddresses.feeDistributor,
            swapBonus: swapBonus.address,
            liquidityGauge: liquidityGauge.address,
            stableSwap: stableSwap.address,
        };
        saveAddressFile(
            hre,
            `${kind.toLowerCase()}_stable_swap_${underlyingSymbol.toLowerCase()}`,
            addresses
        );
    });
