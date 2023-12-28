import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, loadAddressFile, newAddresses } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";
import { StableSwapAddresses } from "./deploy_stable_swap";

export interface SwapRouterAddresses extends Addresses {
    swapRouter: string;
}

task("deploy_swap_router", "Deploy swap routers contracts")
    .addParam("wstWrappingSwap", "WstETHWrappingSwap address")
    .addParam("queenSwaps", "Comma-separated fund underlying symbols for QueenStableSwaps")
    .addParam("bishopSwaps", "Comma-separated fund underlying symbols for BishopStableSwaps")
    .addParam("rookSwaps", "Comma-separated fund underlying symbols for BishopStableSwaps")
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
        const rookSwaps: string[] = args.rookSwaps.split(",").filter(Boolean);
        for (const rookSwap of rookSwaps) {
            assert.match(rookSwap, /^[a-zA-Z]+$/, "Invalid symbol");
        }

        const wstETHWrappingSwap = await ethers.getContractAt(
            "WstETHWrappingSwap",
            args.wstWrappingSwap
        );
        const wstETHAddress = await wstETHWrappingSwap.wstETH();
        const stETHAddress = await wstETHWrappingSwap.stETH();
        const wstETH = await ethers.getContractAt("IWstETH", wstETHAddress);
        assert.strictEqual(await wstETH.stETH(), stETHAddress);

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
        for (const rookSwap of rookSwaps) {
            const rookSwapAddresses = loadAddressFile<StableSwapAddresses>(
                hre,
                `rook_stable_swap_${rookSwap.toLowerCase()}`
            );
            swapAddressesList.push(rookSwapAddresses);
        }

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.deploy(wstETH.address);
        console.log(`SwapRouter: ${swapRouter.address}`);

        await swapRouter.addSwap(wstETHAddress, stETHAddress, wstETHWrappingSwap.address);
        for (const swapAddresses of swapAddressesList) {
            const { base, baseSymbol, quote, quoteSymbol, stableSwap } = swapAddresses;
            console.log(`Adding ${baseSymbol}-${quoteSymbol} to the swap router`);
            await swapRouter.addSwap(base, quote, stableSwap);
        }

        console.log("Transfering ownership to TimelockController");
        await swapRouter.transferOwnership(governanceAddresses.timelockController);

        const addresses: SwapRouterAddresses = {
            ...newAddresses(hre),
            swapRouter: swapRouter.address,
        };
        saveAddressFile(hre, `swap_router`, addresses);
    });
