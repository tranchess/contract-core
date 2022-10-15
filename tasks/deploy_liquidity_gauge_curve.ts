import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { GAUGE_ABI, MINTER_ABI } from "./dev_deploy_curve";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface LiquidityGaugeCurveAddresses extends Addresses {
    gauge: string;
    router: string;
}

task("deploy_liquidity_gauge_curve", "Deploy LiquidityGaugeCurve")
    .addParam("curveGauge", "Curve LiquidityGauge contract address")
    .addParam("curveMinter", "Curve Minter contract address")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");
        const [deployer] = await ethers.getSigners();

        const curveGauge = await ethers.getContractAt(GAUGE_ABI, args.curveGauge);
        assert.strictEqual(
            await curveGauge.rewards_receiver(deployer.address),
            ethers.constants.AddressZero
        );
        const curveMinter = await ethers.getContractAt(MINTER_ABI, args.curveMinter);
        assert.notStrictEqual(await curveMinter.controller(), ethers.constants.AddressZero);
        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const LiquidityGaugeCurve = await ethers.getContractFactory("LiquidityGaugeCurve");
        const gauge = await LiquidityGaugeCurve.deploy(
            "Tranchess qETH-ETH gauge",
            "qETH-LP-gauge",
            curveGauge.address,
            curveMinter.address,
            governanceAddresses.chessSchedule,
            governanceAddresses.chessController,
            governanceAddresses.votingEscrow
        );
        console.log(`LiquidityGaugeCurve: ${gauge.address}`);

        const CurveRouter = await ethers.getContractFactory("CurveRouter");
        const router = await CurveRouter.deploy(gauge.address);
        console.log(`CurveRouter: ${router.address}`);

        console.log("Setting Curve's rewards receiver to the treasury");
        await gauge.setRewardsReceiver(GOVERNANCE_CONFIG.TREASURY || deployer.address);

        const controllerBallot = await ethers.getContractAt(
            "ControllerBallotV2",
            governanceAddresses.controllerBallot
        );
        if ((await controllerBallot.owner()) === deployer.address) {
            console.log("Adding LiquidityGaugeCurve to ControllerBallot");
            await controllerBallot.addPool(gauge.address);
            console.log("NOTE: Please transfer ownership of ControllerBallot to Timelock later");
        } else {
            console.log("NOTE: Please add LiquidityGaugeCurve to ControllerBallot");
        }

        const chessSchedule = await ethers.getContractAt(
            "ChessSchedule",
            governanceAddresses.chessSchedule
        );
        if ((await chessSchedule.owner()) === deployer.address) {
            console.log("Adding LiquidityGaugeCurve to ChessSchedule's minter list");
            await chessSchedule.addMinter(gauge.address);
            console.log("NOTE: Please transfer ownership of ChessSchedule to Timelock later");
        } else {
            console.log("NOTE: Please add LiquidityGaugeCurve to ChessSchedule's minter list");
        }

        console.log("Transfering ownership to TimelockController");
        await gauge.transferOwnership(governanceAddresses.timelockController);

        const addresses: LiquidityGaugeCurveAddresses = {
            ...newAddresses(hre),
            gauge: gauge.address,
            router: router.address,
        };
        saveAddressFile(hre, "liquidity_gauge_curve", addresses);
    });
