import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { updateHreSigner } from "./signers";

const TOKEN_HUB_ADDR = "0x0000000000000000000000000000000000001004";

task("dev_deploy_token_hub", "Deploy a mock contract for BSC precompiled TokenHub")
    .addFlag("force", "Replace code if the address has code before")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers, waffle } = hre;
        const { deployMockContract } = waffle;
        const [deployer] = await ethers.getSigners();
        await hre.run("compile");

        const previousCode = await ethers.provider.send("eth_getCode", [TOKEN_HUB_ADDR]);
        if (previousCode !== "0x") {
            assert.ok(args.force, "The TokenHub address is already a smart contract");
        }
        // Make sure "hardhat_setCode" is available
        await ethers.provider.send("hardhat_setCode", [TOKEN_HUB_ADDR, "0x"]);

        const MockTokenHub = await ethers.getContractAt("ITokenHub", ethers.constants.AddressZero);
        const mockTokenHub = await deployMockContract(
            deployer,
            MockTokenHub.interface.format() as string[]
        );
        const code = await ethers.provider.send("eth_getCode", [mockTokenHub.address]);
        console.log(`Setting contract code to address ${TOKEN_HUB_ADDR}`);
        await ethers.provider.send("hardhat_setCode", [TOKEN_HUB_ADDR, code]);

        // Send mock transactions
        const startBlock = await ethers.provider.getBlockNumber();
        await mockTokenHub.mock.getMiniRelayFee.returns(ethers.utils.parseEther("0.002"));
        await mockTokenHub.mock.transferOut.returns(true);
        const endBlock = await ethers.provider.getBlockNumber();

        // Replay mock transactions on TOKEN_HUB_ADDR
        console.log("Setting return values of mock functions");
        for (let blockNumber = startBlock + 1; blockNumber <= endBlock; blockNumber++) {
            const block = await ethers.provider.getBlockWithTransactions(blockNumber);
            for (const tx of block.transactions) {
                if (tx.from === deployer.address && tx.to === mockTokenHub.address) {
                    await deployer.sendTransaction({
                        to: TOKEN_HUB_ADDR,
                        data: tx.data,
                    });
                }
            }
        }
    });
