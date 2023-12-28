import { task } from "hardhat/config";
import { keyInYNStrict } from "readline-sync";
import { Addresses, saveAddressFile, newAddresses } from "./address_file";
import { updateHreSigner } from "./signers";

export interface MockAddresses extends Addresses {
    mockAprOracle: string;
    mockVToken: string;
    mockBtc: string;
    mockEth: string;
    mockWeth: string;
    mockWbnb: string;
    mockUsdc: string;
    mockBusd: string;
    mockStEth: string;
    mockWstEth: string;
    mockUniswapV2Pair: string;
}

task("deploy_mock", "Deploy mock contracts")
    .addFlag("silent", 'Assume "yes" as answer to all prompts and run non-interactively')
    .addOptionalParam("initialTwap", "Initial price of the MockTwapOracle", "")
    .setAction(async (args, hre) => {
        await updateHreSigner(hre);
        const { ethers, waffle } = hre;
        const { parseEther } = ethers.utils;
        const { deployMockContract } = waffle;
        await hre.run("compile");
        const [deployer] = await ethers.getSigners();

        let mockAprOracleAddress = "";
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
            mockAprOracleAddress = mockAprOracle.address;
            await mockAprOracle.mock.capture.returns(parseEther("0.000261157876067812")); // 1.1 ^ (1/365) - 1
        }

        let mockVTokenAddress = "";
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
            mockVTokenAddress = mockVToken.address;
            await mockVToken.mock.borrowRatePerBlock.returns(0);
            await mockVToken.mock.borrowIndex.returns(0);
            await mockVToken.mock.accrualBlockNumber.returns(0);
        }

        let mockBtcAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockBtc?", { guide: true })) {
            const MockToken = await ethers.getContractFactory("MockToken");
            const mockBtc = await MockToken.deploy("Mock BTC", "BTC", 8);
            console.log(`MockBtc: ${mockBtc.address}`);
            mockBtcAddress = mockBtc.address;
            await mockBtc.mint(deployer.address, 1000000e8);
        }

        let mockEthAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockEth?", { guide: true })) {
            const MockToken = await ethers.getContractFactory("MockToken");
            const mockEth = await MockToken.deploy("Mock ETH", "ETH", 18);
            console.log(`MockEth: ${mockEth.address}`);
            mockEthAddress = mockEth.address;
            await mockEth.mint(deployer.address, parseEther("1000000"));
        }

        let mockWbnbAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockWbnb?", { guide: true })) {
            const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
            const mockWbnb = await MockWrappedToken.deploy("Wrapped BNB", "WBNB");
            console.log(`MockWbnb: ${mockWbnb.address}`);
            mockWbnbAddress = mockWbnb.address;
        }

        let mockUsdcAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockUsdc?", { guide: true })) {
            const MockToken = await ethers.getContractFactory("MockToken");
            const mockUsdc = await MockToken.deploy("Mock USDC", "USDC", 6);
            console.log(`MockUsdc: ${mockUsdc.address}`);
            mockUsdcAddress = mockUsdc.address;
            await mockUsdc.mint(deployer.address, 1000000e6);
        }
        let mockBusdAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockBusd?", { guide: true })) {
            const MockToken = await ethers.getContractFactory("MockToken");
            const mockBusd = await MockToken.deploy("Mock BUSD", "BUSD", 6);
            console.log(`MockBusd: ${mockBusd.address}`);
            mockBusdAddress = mockBusd.address;
            await mockBusd.mint(deployer.address, 1000000e6);
        }

        let mockWethAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockWeth?", { guide: true })) {
            const MockWrappedToken = await ethers.getContractFactory("MockWrappedToken");
            const mockWeth = await MockWrappedToken.deploy("Wrapped ETH", "WETH");
            console.log(`MockWeth: ${mockWeth.address}`);
            mockWethAddress = mockWeth.address;
        }

        let mockStEthAddress = "";
        let mockWstEthAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockStEth and MockWstEth?", { guide: true })) {
            const MockToken = await ethers.getContractFactory("MockToken");
            const mockStEth = await MockToken.deploy("Mock stETH", "stETH", 18);
            console.log(`MockStEth: ${mockStEth.address}`);
            const MockWstETH = await ethers.getContractFactory("MockWstETH");
            const mockWstEth = await MockWstETH.deploy(mockStEth.address);
            await mockWstEth.update(parseEther("1"));
            console.log(`MockWstEth: ${mockWstEth.address}`);
            mockStEthAddress = mockStEth.address;
            mockWstEthAddress = mockWstEth.address;
            await mockStEth.mint(deployer.address, parseEther("2000000"));
            await mockStEth.approve(mockWstEth.address, parseEther("1000000"));
            await mockWstEth.wrap(parseEther("1000000"));
        }

        let mockUniswapV2PairAddress = "";
        if (args.silent || keyInYNStrict("Deploy MockUniswapV2Pair?", { guide: true })) {
            const MockUniswapV2Pair = await ethers.getContractAt(
                "IUniswapV2Pair",
                ethers.constants.AddressZero
            );
            const mockUniswapV2Pair = await deployMockContract(
                deployer,
                MockUniswapV2Pair.interface.format() as string[]
            );
            console.log(`MockUniswapV2Pair: ${mockUniswapV2Pair.address}`);
            mockUniswapV2PairAddress = mockUniswapV2Pair.address;
            console.log(
                "Please manually set return values of token0(), token1() and getReserves() for MockUniswapV2Pair"
            );
        }

        const addresses: MockAddresses = {
            ...newAddresses(hre),
            mockAprOracle: mockAprOracleAddress,
            mockVToken: mockVTokenAddress,
            mockBtc: mockBtcAddress,
            mockEth: mockEthAddress,
            mockWeth: mockWethAddress,
            mockWbnb: mockWbnbAddress,
            mockUsdc: mockUsdcAddress,
            mockBusd: mockBusdAddress,
            mockStEth: mockStEthAddress,
            mockWstEth: mockWstEthAddress,
            mockUniswapV2Pair: mockUniswapV2PairAddress,
        };
        saveAddressFile(hre, "mock", addresses);
    });
