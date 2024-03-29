import { task } from "hardhat/config";
import { Addresses, loadAddressFile, newAddresses, saveAddressFile } from "./address_file";
import type { FlashSwapRouterAddresses } from "./deploy_flash_swap_router";
import type { GovernanceAddresses } from "./deploy_governance";
import type { StableSwapAddresses } from "./deploy_stable_swap";
import type { SwapRouterAddresses } from "./deploy_swap_router";
import { updateHreSigner } from "./signers";

export interface DataAggregatorAddresses extends Addresses {
    dataAggregator: string;
}

task("deploy_data_aggregator", "Deploy data aggregator")
    .addParam("firstUnderlyingSymbol", "Fund0 underlying symbols")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const firstUnderlyingSymbol = args.firstUnderlyingSymbol;

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
            ethers.constants.AddressZero,
            []
        );
        console.log(`Data Aggregator: ${dataAggregator.address}`);

        const addresses: DataAggregatorAddresses = {
            ...newAddresses(hre),
            dataAggregator: dataAggregator.address,
        };
        saveAddressFile(hre, `data_aggregator`, addresses);
    });
