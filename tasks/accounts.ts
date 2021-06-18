import { task } from "hardhat/config";
import { updateHreSigner } from "./signers";

task("accounts", "Prints the list of accounts", async (_args, hre) => {
    await updateHreSigner(hre);
    const accounts = await hre.ethers.getSigners();
    for (const account of accounts) {
        console.log(account.address);
    }
});
