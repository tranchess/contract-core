import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import type { StableSwapAddresses } from "./deploy_stable_swap";
import type { SwapRouterAddresses } from "./deploy_swap_router";
import type { FlashSwapRouterAddresses } from "./deploy_flash_swap_router";
import { GOVERNANCE_CONFIG } from "../config";
import { updateHreSigner } from "./signers";

export interface DataAggregatorAddresses extends Addresses {
    dataAggregator: string;
}

task("deploy_data_aggregator", "Deploy data aggregator")
    .addParam("firstUnderlyingSymbol", "Fund0 underlying symbols")
    .addParam("otherChainIds", "Comma-separated chain IDs")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const firstUnderlyingSymbol = args.firstUnderlyingSymbol;
        const otherChainIds: number[] = args.otherChainIds
            .split(",")
            .filter(Boolean)
            .map((x: string) => parseInt(x));
        for (const chainId of otherChainIds) {
            assert.ok(chainId > 0 && chainId < 1e9, "Invalid chain ID");
        }

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const swapRouterAddresses = loadAddressFile<SwapRouterAddresses>(hre, "swap_router");
        const flashSwapRouterAddresses = loadAddressFile<FlashSwapRouterAddresses>(
            hre,
            "flash_swap_router"
        );
        const bishopStableSwapAddress = loadAddressFile<StableSwapAddresses>(
            hre,
            `bishop_stable_swap_${firstUnderlyingSymbol.toLowerCase()}`
        );

        const DataAggregator = await ethers.getContractFactory("DataAggregator");
        const dataAggregator = await DataAggregator.deploy(
            governanceAddresses.votingEscrow,
            governanceAddresses.chessSchedule,
            governanceAddresses.controllerBallot,
            governanceAddresses.interestRateBallot,
            swapRouterAddresses.swapRouter,
            flashSwapRouterAddresses.flashSwapRouter,
            bishopStableSwapAddress.quote,
            GOVERNANCE_CONFIG.ANY_CALL_PROXY,
            otherChainIds
        );
        console.log(`Data Aggregator: ${dataAggregator.address}`);

        const addresses: DataAggregatorAddresses = {
            ...newAddresses(hre),
            dataAggregator: dataAggregator.address,
        };
        saveAddressFile(hre, `data_aggregator`, addresses);
    });
