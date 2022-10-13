import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { Addresses, saveAddressFile, newAddresses, loadAddressFile } from "./address_file";
import type { GovernanceAddresses } from "./deploy_governance";
import { updateHreSigner } from "./signers";

export interface EthStrategyAddresses extends Addresses {
    strategy: string;
    nodeOperatorRegistry: string;
    withdrawalManager: string;
    withdrawalManagerFactory: string;
}

task("deploy_eth_staking_strategy", "Deploy EthStakingStrategy")
    .addParam("fund", "Fund contract address")
    .addParam("depositContract", "Deposit contract address")
    .addParam("totalFeeRate", "Total fee rate")
    .addParam("operatorFeeRate", "Node operator fee rate")
    .setAction(async function (args, hre) {
        await updateHreSigner(hre);
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        await hre.run("compile");
        const [deployer] = await ethers.getSigners();

        const totalFeeRate = parseEther(args.totalFeeRate);
        const operatorFeeRate = parseEther(args.operatorFeeRate);

        // +0 EthStakingStrategy
        // +1 NodeOperatorRegistry
        // +2 WithdrawalManager
        // +3 WithdrawalManagerFactory
        const registryAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 1,
        });
        const factoryAddress = ethers.utils.getContractAddress({
            from: deployer.address,
            nonce: (await deployer.getTransactionCount("pending")) + 3,
        });

        const EthStakingStrategy = await ethers.getContractFactory("EthStakingStrategy");
        const ethStakingStrategy = await EthStakingStrategy.deploy(
            args.fund,
            args.depositContract,
            registryAddress,
            totalFeeRate,
            operatorFeeRate
        );
        console.log(`EthStakingStrategy: ${ethStakingStrategy.address}`);

        const NodeOperatorRegistry = await ethers.getContractFactory("NodeOperatorRegistry");
        const nodeOperatorRegistry = await NodeOperatorRegistry.deploy(
            ethStakingStrategy.address,
            factoryAddress
        );
        assert.strictEqual(nodeOperatorRegistry.address, registryAddress);
        console.log(`NodeOperatorRegistry: ${nodeOperatorRegistry.address}`);

        const WithdrawalManager = await ethers.getContractFactory("WithdrawalManager");
        const withdrawalManager = await WithdrawalManager.deploy(ethStakingStrategy.address);
        console.log(`WithdrawalManager: ${withdrawalManager.address}`);

        const WithdrawalManagerFactory = await ethers.getContractFactory(
            "WithdrawalManagerFactory"
        );
        const withdrawalManagerFactory = await WithdrawalManagerFactory.deploy(
            withdrawalManager.address
        );
        assert.strictEqual(withdrawalManagerFactory.address, factoryAddress);
        console.log(`WithdrawalManagerFactory: ${withdrawalManagerFactory.address}`);

        console.log("Initialize the WithdrawalManager implementation");
        await withdrawalManager.initialize(ethers.BigNumber.from(1).shl(256).sub(1));

        console.log("Transfering ownership to Timelock");
        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        await ethStakingStrategy.transferOwnership(governanceAddresses.timelockController);
        await nodeOperatorRegistry.transferOwnership(governanceAddresses.timelockController);
        await withdrawalManagerFactory.transferOwnership(governanceAddresses.timelockController);

        const addresses: EthStrategyAddresses = {
            ...newAddresses(hre),
            strategy: ethStakingStrategy.address,
            nodeOperatorRegistry: nodeOperatorRegistry.address,
            withdrawalManager: withdrawalManager.address,
            withdrawalManagerFactory: withdrawalManagerFactory.address,
        };
        saveAddressFile(hre, "eth_staking_strategy", addresses);
    });
