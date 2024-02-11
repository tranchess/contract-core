import { HardhatRuntimeEnvironment } from "hardhat/types";

export async function waitForContract(hre: HardhatRuntimeEnvironment, addr: string): Promise<void> {
    const { ethers } = hre;
    let delay = 1000;
    while ((await ethers.provider.getCode(addr)) === "0x") {
        console.log(`Waiting contract deployment at ${addr}`);
        await new Promise((r) => setTimeout(r, delay)); // Sleep
        if (delay < 16000) {
            delay *= 2;
        }
    }
}
