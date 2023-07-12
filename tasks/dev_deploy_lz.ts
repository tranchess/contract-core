import { strict as assert } from "assert";
import { task } from "hardhat/config";
import { endOfWeek } from "../config";
import { Addresses, loadAddressFile, newAddresses, saveAddressFile } from "./address_file";
import { ChessScheduleRelayerAddresses } from "./deploy_chess_schedule_relayer";
import type { GovernanceAddresses } from "./deploy_governance";

export interface LzAddresses extends Addresses {
    endpoint: string;
}

const DEV_CHAIN_ID_BSC = 5777;
const DEV_CHAIN_ID_ETH = 5701;

const CHESS_PAYLOAD_LENGTH = 160;
const CHESS_GAS_LIMIT = 90000;
const VECHESS_PAYLOAD_LENGTH = 96;
const VECHESS_GAS_ESTIMATION = 200000;
const SYNC_PAYLOAD_LENGTH = 96;
const SYNC_GAS_LIMIT = 90000;
const MINT_PAYLOAD_LENGTH = 32;
const MINT_GAS_LIMIT = 100000;

task("dev_deploy_lz", "Deploy LayerZero mock contracts").setAction(async function (_args, hre) {
    const { ethers } = hre;

    const LZEndpointMock = await ethers.getContractFactory("LZEndpointMock");
    const endpoint = await LZEndpointMock.deploy(hre.network.config.chainId);

    const addresses: LzAddresses = {
        ...newAddresses(hre),
        endpoint: endpoint.address,
    };
    saveAddressFile(hre, `dev_lz`, addresses);
});

task("dev_chess_out", "Send CHESS to the other dev chain")
    .addParam("to", "Target address")
    .addParam("amount", "Amount of CHESS")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const [deployer] = await ethers.getSigners();
        const { parseEther, formatEther } = ethers.utils;

        const to: string = args.to;
        const amount = parseEther(args.amount);

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const chess = await ethers.getContractAt("ERC20", governanceAddresses.chess);
        const chessPool = await ethers.getContractAt("ProxyOFTPool", governanceAddresses.chessPool);
        const lzEndpoint = await ethers.getContractAt(
            "ILayerZeroEndpoint",
            loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
        );

        const targetChain =
            hre.network.config.chainId === DEV_CHAIN_ID_BSC ? DEV_CHAIN_ID_ETH : DEV_CHAIN_ID_BSC;
        const adapterParams = ethers.utils.solidityPack(["uint16", "uint"], [1, CHESS_GAS_LIMIT]);
        const fee = (
            await lzEndpoint.estimateFees(
                targetChain,
                chessPool.address,
                ethers.utils.hexZeroPad("0x", CHESS_PAYLOAD_LENGTH),
                false,
                adapterParams
            )
        ).nativeFee;
        console.log(
            `Transferring ${formatEther(
                amount
            )} CHESS to ${to} on Chain ${targetChain} with fee ${formatEther(fee)}`
        );
        await chess.approve(chessPool.address, amount);
        await chessPool.sendFrom(
            deployer.address,
            targetChain,
            ethers.utils.solidityPack(["address"], [to]),
            amount,
            deployer.address,
            ethers.constants.AddressZero,
            adapterParams,
            { value: fee }
        );
    });

task("dev_chess_in", "Receive CHESS from the other dev chain")
    .addParam("to", "Target address")
    .addParam("amount", "Amount of CHESS")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const [deployer] = await ethers.getSigners();
        const { parseEther, formatEther } = ethers.utils;

        const to: string = args.to;
        const amount = parseEther(args.amount);

        const governanceAddresses = loadAddressFile<GovernanceAddresses>(hre, "governance");
        const chessPool = await ethers.getContractAt("ProxyOFTPool", governanceAddresses.chessPool);
        const lzEndpoint = await ethers.getContractAt(
            "ILayerZeroEndpoint",
            loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
        );

        const sourceChain =
            hre.network.config.chainId === DEV_CHAIN_ID_BSC ? DEV_CHAIN_ID_ETH : DEV_CHAIN_ID_BSC;
        const path = ethers.utils.solidityPack(
            ["address", "address"],
            [deployer.address, chessPool.address]
        );
        const nonce = (await lzEndpoint.getInboundNonce(sourceChain, path)).add(1);
        const payload = ethers.utils.defaultAbiCoder.encode(
            ["uint16", "bytes", "uint256"],
            [0, ethers.utils.solidityPack(["address"], [to]), amount]
        );
        console.log(`Transferring ${formatEther(amount)} CHESS to ${to} from Chain ${sourceChain}`);
        await lzEndpoint.receivePayload(
            sourceChain,
            path,
            chessPool.address,
            nonce,
            CHESS_GAS_LIMIT,
            payload,
            { gasLimit: CHESS_GAS_LIMIT + 2e5 }
        );
    });

task("dev_vechess_out", "Send veCHESS to the other dev chain")
    .addParam("amount", "Amount of CHESS")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const { parseEther, formatEther } = ethers.utils;

        const amount = parseEther(args.amount);

        const lzEndpoint = await ethers.getContractAt(
            "ILayerZeroEndpoint",
            loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
        );
        const votingEscrow = await ethers.getContractAt(
            "VotingEscrowV4",
            loadAddressFile<GovernanceAddresses>(hre, "governance").votingEscrow
        );

        const targetChain =
            hre.network.config.chainId === DEV_CHAIN_ID_BSC ? DEV_CHAIN_ID_ETH : DEV_CHAIN_ID_BSC;
        const adapterParams = ethers.utils.solidityPack(
            ["uint16", "uint"],
            [1, VECHESS_GAS_ESTIMATION]
        );
        const fee = (
            await lzEndpoint.estimateFees(
                targetChain,
                votingEscrow.address,
                ethers.utils.hexZeroPad("0x", VECHESS_PAYLOAD_LENGTH),
                false,
                adapterParams
            )
        ).nativeFee;
        console.log(
            `Transferring ${formatEther(
                amount
            )} locked CHESS to the other dev chain with fee ${formatEther(fee)}`
        );
        await votingEscrow.veChessCrossChain(amount, targetChain, adapterParams, { value: fee });
    });

task("dev_vechess_in", "Receive veCHESS from the other dev chain")
    .addParam("to", "Target address")
    .addParam("amount", "Amount of CHESS")
    .addParam("unlockDate", "Unlock date (YYYY-MM-DD)")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const { parseEther, formatEther } = ethers.utils;
        const [deployer] = await ethers.getSigners();

        const to: string = args.to;
        const amount = parseEther(args.amount);
        const unlockTimestamp = endOfWeek(new Date(args.unlockDate).getTime() / 1000);

        const lzEndpoint = await ethers.getContractAt(
            "ILayerZeroEndpoint",
            loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
        );
        const votingEscrow = await ethers.getContractAt(
            "VotingEscrowV4",
            loadAddressFile<GovernanceAddresses>(hre, "governance").votingEscrow
        );

        const sourceChain =
            hre.network.config.chainId === DEV_CHAIN_ID_BSC ? DEV_CHAIN_ID_ETH : DEV_CHAIN_ID_BSC;
        const path = ethers.utils.solidityPack(
            ["address", "address"],
            [deployer.address, votingEscrow.address]
        );
        const nonce = (await lzEndpoint.getInboundNonce(sourceChain, path)).add(1);
        const payload = ethers.utils.defaultAbiCoder.encode(
            ["address", "uint256", "uint256"],
            [to, amount, unlockTimestamp]
        );
        const gasEstimation = (
            await ethers.provider.estimateGas({
                ...(await votingEscrow.populateTransaction.lzReceive(
                    sourceChain,
                    path,
                    nonce,
                    payload
                )),
                from: lzEndpoint.address,
            })
        ).toNumber();
        const gas = Math.ceil(gasEstimation * 1.05) + 30000;
        console.log(
            `Transferring ${formatEther(
                amount
            )} locked CHESS (unlocked at ${unlockTimestamp}) to ${to} from the other dev chain`
        );
        console.log(`Gas estimation: ${gas}`);
        await lzEndpoint.receivePayload(
            sourceChain,
            path,
            votingEscrow.address,
            nonce,
            gas,
            payload,
            { gasLimit: gas + 2e5 }
        );
    });

task("dev_sync_out", "Send total vote to the main chain").setAction(async function (args, hre) {
    const { ethers } = hre;
    const { formatEther } = ethers.utils;

    assert.strictEqual(
        hre.network.config.chainId,
        DEV_CHAIN_ID_ETH,
        "Should send sub chain vote only on the sub chain"
    );
    const targetChain = DEV_CHAIN_ID_BSC;

    const lzEndpoint = await ethers.getContractAt(
        "ILayerZeroEndpoint",
        loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
    );
    const chessSubSchedule = await ethers.getContractAt(
        "ChessSubSchedule",
        loadAddressFile<GovernanceAddresses>(hre, "governance").chessSchedule
    );

    const adapterParams = ethers.utils.solidityPack(["uint16", "uint"], [1, SYNC_GAS_LIMIT]);
    const fee = (
        await lzEndpoint.estimateFees(
            targetChain,
            chessSubSchedule.address,
            ethers.utils.hexZeroPad("0x", SYNC_PAYLOAD_LENGTH),
            false,
            adapterParams
        )
    ).nativeFee;
    console.log(`Sending total vote to chain ${targetChain} with fee ${formatEther(fee)}`);
    await chessSubSchedule.crossChainSync(adapterParams, { value: fee });
});

task("dev_sync_in", "Receive total vote from the sub chain")
    .addParam("amount", "Amount of veCHESS at the end of this week")
    .addParam("nextAmount", "Amount of veCHESS at the end of the next week")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        const [deployer] = await ethers.getSigners();

        assert.strictEqual(
            hre.network.config.chainId,
            DEV_CHAIN_ID_BSC,
            "Should receive sub chain vote only on the main chain"
        );
        const sourceChain = DEV_CHAIN_ID_ETH;
        const amount = parseEther(args.amount);
        const nextAmount = parseEther(args.nextAmount);
        const week = endOfWeek((await ethers.provider.getBlock("latest")).timestamp);

        const lzEndpoint = await ethers.getContractAt(
            "ILayerZeroEndpoint",
            loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
        );
        const chessScheduleRelayer = await ethers.getContractAt(
            "ChessScheduleRelayer",
            loadAddressFile<ChessScheduleRelayerAddresses>(
                hre,
                `chess_schedule_relayer_${sourceChain}`
            ).relayer
        );

        const path = ethers.utils.solidityPack(
            ["address", "address"],
            [deployer.address, chessScheduleRelayer.address]
        );
        const nonce = (await lzEndpoint.getInboundNonce(sourceChain, path)).add(1);
        const payload = ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "uint256"],
            [week, amount, nextAmount]
        );
        console.log(
            `Receiving total vote of chain ${sourceChain}: week ${week}, supply ${amount}, nextWeekSupply ${nextAmount}`
        );
        await lzEndpoint.receivePayload(
            sourceChain,
            path,
            chessScheduleRelayer.address,
            nonce,
            SYNC_GAS_LIMIT,
            payload,
            { gasLimit: SYNC_GAS_LIMIT + 2e5 }
        );
    });

task("dev_mint_out", "Send CHESS emission to the sub chain").setAction(async function (args, hre) {
    const { ethers } = hre;
    const { formatEther } = ethers.utils;

    assert.strictEqual(
        hre.network.config.chainId,
        DEV_CHAIN_ID_BSC,
        "Should send emission only on the main chain"
    );
    const targetChain = DEV_CHAIN_ID_ETH;

    const lzEndpoint = await ethers.getContractAt(
        "ILayerZeroEndpoint",
        loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
    );
    const chessScheduleRelayer = await ethers.getContractAt(
        "ChessScheduleRelayer",
        loadAddressFile<ChessScheduleRelayerAddresses>(hre, `chess_schedule_relayer_${targetChain}`)
            .relayer
    );

    const adapterParams = ethers.utils.solidityPack(["uint16", "uint"], [1, MINT_GAS_LIMIT]);
    const fee = (
        await lzEndpoint.estimateFees(
            targetChain,
            chessScheduleRelayer.address,
            ethers.utils.hexZeroPad("0x", MINT_PAYLOAD_LENGTH),
            false,
            adapterParams
        )
    ).nativeFee;
    console.log(`Sending CHESS emission to the sub chain with fee ${formatEther(fee)}`);
    await chessScheduleRelayer.crossChainMint(adapterParams, { value: fee });
});

task("dev_mint_in", "Receive CHESS emission from the main chain")
    .addParam("amount", "Amount of CHESS")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const { parseEther } = ethers.utils;
        const [deployer] = await ethers.getSigners();

        assert.strictEqual(
            hre.network.config.chainId,
            DEV_CHAIN_ID_ETH,
            "Should receive CHESS emission only on the sub chain"
        );
        const sourceChain = DEV_CHAIN_ID_BSC;
        const amount = parseEther(args.amount);

        const lzEndpoint = await ethers.getContractAt(
            "ILayerZeroEndpoint",
            loadAddressFile<LzAddresses>(hre, "dev_lz").endpoint
        );
        const chessSubSchedule = await ethers.getContractAt(
            "ChessSubSchedule",
            loadAddressFile<GovernanceAddresses>(hre, "governance").chessSchedule
        );

        const path = ethers.utils.solidityPack(
            ["address", "address"],
            [deployer.address, chessSubSchedule.address]
        );
        const nonce = (await lzEndpoint.getInboundNonce(sourceChain, path)).add(1);
        const payload = ethers.utils.defaultAbiCoder.encode(["uint256"], [amount]);
        console.log(`Receiving CHESS emission from chain ${sourceChain}: amount ${amount}`);
        await lzEndpoint.receivePayload(
            sourceChain,
            path,
            chessSubSchedule.address,
            nonce,
            MINT_GAS_LIMIT,
            payload,
            { gasLimit: MINT_GAS_LIMIT + 2e5 }
        );
    });
