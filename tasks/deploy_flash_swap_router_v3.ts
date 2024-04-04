import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import { updateHreSigner } from "./signers";
import { SwapRouterAddresses } from "./deploy_swap_router";

export interface FlashSwapRouterAddresses extends Addresses {
    flashSwapRouter: string;
}

task("deploy_flash_swap_router_v3", "Deploy FlashSwapRouterV3").setAction(async function (
    _args,
    hre
) {
    await updateHreSigner(hre);
    const { ethers } = hre;
    await hre.run("compile");

    const swapRouterAddresses = loadAddressFile<SwapRouterAddresses>(hre, "swap_router");
    const swapRouter = await ethers.getContractAt("SwapRouter", swapRouterAddresses.swapRouter);

    const FlashSwapRouter = await ethers.getContractFactory("FlashSwapRouterV3");
    const flashSwapRouter = await FlashSwapRouter.deploy(swapRouter.address);
    console.log(`FlashSwapRouter: ${flashSwapRouter.address}`);

    const addresses: FlashSwapRouterAddresses = {
        ...newAddresses(hre),
        flashSwapRouter: flashSwapRouter.address,
    };
    saveAddressFile(hre, `flash_swap_router`, addresses);
});
