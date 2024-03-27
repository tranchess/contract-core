import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";
import { StableSwapAddresses } from "./deploy_stable_swap";
import { waitForContract } from "./utils";

export interface SwapRouterAddresses extends Addresses {
    swapRouter: string;
}

task("deploy_swap_router", "Deploy swap routers contracts")
    .addOptionalParam("wstWrappingSwap", "WstETHWrappingSwap address", "")
    .addParam("queenSwaps", "Comma-separated fund underlying symbols for QueenStableSwaps")
    .addParam("bishopSwaps", "Comma-separated fund underlying symbols for BishopStableSwaps")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        await hre.run("compile");

        const queenSwaps: string[] = args.queenSwaps.split(",").filter(Boolean);
        for (const queenSwap of queenSwaps) {
            assert.match(queenSwap, /^[a-zA-Z]+$/, "Invalid symbol");
        }
        const bishopSwaps: string[] = args.bishopSwaps.split(",").filter(Boolean);
        for (const bishopSwap of bishopSwaps) {
            assert.match(bishopSwap, /^[a-zA-Z]+$/, "Invalid symbol");
        }

        let wstETHAddress = ethers.constants.AddressZero;
        let stETHAddress = ethers.constants.AddressZero;
        if (args.wstWrappingSwap) {
            const wstETHWrappingSwap = await ethers.getContractAt(
                "WstETHWrappingSwap",
                args.wstWrappingSwap
            );
            wstETHAddress = await wstETHWrappingSwap.wstETH();
            stETHAddress = await wstETHWrappingSwap.stETH();
            const wstETH = await ethers.getContractAt("IWstETH", wstETHAddress);
            assert.strictEqual(await wstETH.stETH(), stETHAddress);
        }

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");

        const swapAddressesList: StableSwapAddresses[] = [];
        for (const queenSwap of queenSwaps) {
            const queenSwapAddresses = loadAddressFile<StableSwapAddresses>(
                hre,
                `queen_stable_swap_${queenSwap.toLowerCase()}`
            );
            swapAddressesList.push(queenSwapAddresses);
        }
        for (const bishopSwap of bishopSwaps) {
            const bishopSwapAddresses = loadAddressFile<StableSwapAddresses>(
                hre,
                `bishop_stable_swap_${bishopSwap.toLowerCase()}`
            );
            swapAddressesList.push(bishopSwapAddresses);
        }

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.deploy(wstETHAddress);
        console.log(`SwapRouter: ${swapRouter.address}`);
        await waitForContract(hre, swapRouter.address);

        if (args.wstWrappingSwap) {
            await (
                await swapRouter.addSwap(wstETHAddress, stETHAddress, args.wstWrappingSwap)
            ).wait();
        }
        for (const swapAddresses of swapAddressesList) {
            const { base, baseSymbol, quote, quoteSymbol, stableSwap } = swapAddresses;
            console.log(`Adding ${baseSymbol}-${quoteSymbol} to the swap router`);
            await (await swapRouter.addSwap(base, quote, stableSwap)).wait();
        }

        console.log("Transfering ownership to TimelockController");
        await (await swapRouter.transferOwnership(governanceAddresses.timelockController)).wait();

        const addresses: SwapRouterAddresses = {
            ...newAddresses(hre),
            swapRouter: swapRouter.address,
        };
        saveAddressFile(hre, `swap_router`, addresses);
    });
