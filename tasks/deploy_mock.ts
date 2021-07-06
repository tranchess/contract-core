import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { createAddressFile } from "./address_file";
import { updateHreSigner } from "./signers";

task("deploy_mock", "Deploy mock contracts")
    .addFlag("silent", 'Assume "yes" as answer to all prompts and run non-interactively')
    .setAction(async (args, hre) => {
        await updateHreSigner(hre);
        const { ethers, waffle } = hre;
        const { parseEther } = ethers.utils;
        const { deployMockContract } = waffle;
        await hre.run("compile");
        const [deployer] = await ethers.getSigners();
        const addressFile = createAddressFile(hre, "mock");

        if (args.silent || keyInYNStrict("Deploy MockTwapOracle?", { guide: true })) {
            const MockTwapOracle = await ethers.getContractAt(
                "ITwapOracle",
                ethers.constants.AddressZero
            );
            const mockTwapOracle = await deployMockContract(
                deployer,
                MockTwapOracle.interface.format() as string[]
            );
            console.log(`MockTwapOracle: ${mockTwapOracle.address}`);
            addressFile.set("mockTwapOracle", mockTwapOracle.address);
            await mockTwapOracle.mock.getTwap.returns(parseEther("10000"));
        }

        if (args.silent || keyInYNStrict("Deploy MockAprOracle?", { guide: true })) {
            const MockAprOracle = await ethers.getContractAt(
                "IAprOracle",
                ethers.constants.AddressZero
            );
            const mockAprOracle = await deployMockContract(
                deployer,
                MockAprOracle.interface.format() as string[]
            );
            console.log(`MockAprOracle: ${mockAprOracle.address}`);
            addressFile.set("mockAprOracle", mockAprOracle.address);
            await mockAprOracle.mock.capture.returns(parseEther("0.000261157876067812")); // 1.1 ^ (1/365) - 1
        }

        if (args.silent || keyInYNStrict("Deploy MockVToken?", { guide: true })) {
            const MockVToken = await ethers.getContractAt(
                "VTokenInterfaces",
                ethers.constants.AddressZero
            );
            const mockVToken = await deployMockContract(
                deployer,
                MockVToken.interface.format() as string[]
            );
            console.log(`MockVToken: ${mockVToken.address}`);
            addressFile.set("mockVToken", mockVToken.address);
            await mockVToken.mock.borrowRatePerBlock.returns(0);
            await mockVToken.mock.borrowIndex.returns(0);
            await mockVToken.mock.accrualBlockNumber.returns(0);
        }

        if (args.silent || keyInYNStrict("Deploy MockBtc?", { guide: true })) {
            const MockToken = await ethers.getContractFactory("MockToken");
            const mockBtc = await MockToken.deploy("Mock BTC", "BTC", 8);
            console.log(`MockBtc: ${mockBtc.address}`);
            addressFile.set("mockBtc", mockBtc.address);
            await mockBtc.mint(deployer.address, 1000000e8);
        }

        if (args.silent || keyInYNStrict("Deploy MockUsdc?", { guide: true })) {
            const MockToken = await ethers.getContractFactory("MockToken");
            const mockUsdc = await MockToken.deploy("Mock USDC", "USDC", 6);
            console.log(`MockUsdc: ${mockUsdc.address}`);
            addressFile.set("mockUsdc", mockUsdc.address);
            await mockUsdc.mint(deployer.address, 1000000e6);
        }

        if (args.silent || keyInYNStrict("Deploy MockPancakePair?", { guide: true })) {
            const MockPancakePair = await ethers.getContractAt(
                "IPancakePair",
                ethers.constants.AddressZero
            );
            const mockPancakePair = await deployMockContract(
                deployer,
                MockPancakePair.interface.format() as string[]
            );
            console.log(`MockPancakePair: ${mockPancakePair.address}`);
            addressFile.set("mockPancakePair", mockPancakePair.address);
            console.log(
                "Please manually set return values of token0(), token1() and getReserves() for MockPancakePair"
            );
        }
    });
