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

task("deploy_stable_swap_wsteth", "Deploy stable swap contracts for wstETH")
    .addParam("kind", "Bishop or Rook stable swap")
    .addParam("ampl", "The ampl of the swap")
    .addParam("feeRate", "The fee rate of the swap")
    .addParam("adminFeeRate", "The admin fee rate of the swap")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");

        assert.match(args.kind, /^Bishop|Rook$/, "Invalid kind");
        const kind: "Bishop" | "Rook" = args.kind;

        const fundAddresses = loadAddressFile<FundAddresses>(hre, "fund_wsteth");
        const feeDistributorAddresses = loadAddressFile<FeeDistrubtorAddresses>(
            hre,
            "fee_distributor_wsteth"
        );
        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const quote = await ethers.getContractAt("ERC20", fundAddresses.underlying);
        const quoteSymbol = await quote.symbol();
        assert.strictEqual(quoteSymbol, "wstETH");
        const quoteDecimals = await quote.decimals();
        assert.strictEqual(quoteDecimals, 18);

        const bonus = quote;
        const bonusSymbol = await bonus.symbol();

        let base: Contract;
        switch (kind) {
            case "Bishop": {
                base = await ethers.getContractAt("ERC20", fundAddresses.shareB);
                break;
            }
            case "Rook": {
                base = await ethers.getContractAt("ERC20", fundAddresses.shareR);
                break;
            }
        }
        const baseSymbol = await base.symbol();

        const ampl = BigNumber.from(args.ampl);
        const feeRate = parseEther(args.feeRate);
        const adminFeeRate = parseEther(args.adminFeeRate);

        const [deployer] = await ethers.getSigners();

        // +0 SwapBonus
        // +1 StableSwap
        // +2 LiquidityGauge
        const liquidityGaugeAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 2,
        });

        console.log(
            `Deploying WstETH${kind}StableSwap between ${baseSymbol}-${quoteSymbol} (Bonus: ${bonusSymbol}).`
        );

        const SwapBonus = await ethers.getContractFactory("SwapBonus");
        const swapBonus = await SwapBonus.deploy(liquidityGaugeAddress, bonus.address);
        console.log(`SwapBonus: ${swapBonus.address}`);

        let stableSwap: Contract;
        switch (kind) {
            case "Bishop": {
                const WstETHBishopStableSwap = await ethers.getContractFactory(
                    "WstETHBishopStableSwap"
                );
                stableSwap = await WstETHBishopStableSwap.deploy(
                    liquidityGaugeAddress,
                    fundAddresses.fund,
                    quote.address,
                    quoteDecimals,
                    ampl,
                    feeDistributorAddresses.feeDistributor,
                    feeRate,
                    adminFeeRate
                );
                break;
            }
            case "Rook": {
                const WstETHRookStableSwap = await ethers.getContractFactory(
                    "WstETHRookStableSwap"
                );
                stableSwap = await WstETHRookStableSwap.deploy(
                    liquidityGaugeAddress,
                    fundAddresses.fund,
                    quote.address,
                    quoteDecimals,
                    ampl,
                    feeDistributorAddresses.feeDistributor,
                    feeRate,
                    adminFeeRate
                );
                break;
            }
        }
        console.log(`StableSwap: ${stableSwap.address}`);

        const chessSchedule = await ethers.getContractAt(
            "ChessSchedule",
            governanceAddresses.chessSchedule
        );

        const LiquidityGauge = await ethers.getContractFactory("LiquidityGaugeV2");
        const liquidityGauge = await LiquidityGauge.deploy(
            `Tranchess ${baseSymbol}-${quoteSymbol}`,
            `${baseSymbol}-LP`,
            stableSwap.address,
            chessSchedule.address,
            governanceAddresses.chessController,
            fundAddresses.fund,
            governanceAddresses.votingEscrow,
            swapBonus.address
        );
        console.log(`LiquidityGauge: ${liquidityGauge.address}`);

        const controllerBallot = await ethers.getContractAt(
            "ControllerBallotV2",
            governanceAddresses.controllerBallot
        );
        if ((await controllerBallot.owner()) === deployer.address) {
            console.log("Adding LiquidityGauge to ControllerBallot");
            await controllerBallot.addPool(liquidityGauge.address);
            console.log("NOTE: Please transfer ownership of ControllerBallot to Timelock later");
        } else {
            console.log("NOTE: Please add LiquidityGauge to ControllerBallot");
        }
        if ((await chessSchedule.owner()) === deployer.address) {
            console.log("Adding LiquidityGauge to ChessSchedule's minter list");
            await chessSchedule.addMinter(liquidityGauge.address);
            console.log("NOTE: Please transfer ownership of ChessSchedule to Timelock later");
        } else {
            console.log("NOTE: Please add LiquidityGauge to ChessSchedule's minter list");
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
            underlyingSymbol: "wstETH",
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
        saveAddressFile(hre, `${kind.toLowerCase()}_stable_swap_wsteth`, addresses);
    });
