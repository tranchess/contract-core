import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers } from "ethers";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { DEPLOYER_HD_PATH } from "../config";

export async function updateHreSigner(hre: HardhatRuntimeEnvironment): Promise<void> {
    if (DEPLOYER_HD_PATH && hre.network.name !== "hardhat") {
        const ledger = new LedgerSigner(hre.ethers.provider, "hid", DEPLOYER_HD_PATH);

        const oldSignMessage = ledger.signMessage;
        ledger.signMessage = async function (
            message: ethers.utils.Bytes | string
        ): Promise<string> {
            console.log("Please sign the following message on Ledger:", message);
            return await oldSignMessage.apply(this, [message]);
        };

        const oldSignTransaction = ledger.signTransaction;
        ledger.signTransaction = async function (
            transaction: ethers.providers.TransactionRequest
        ): Promise<string> {
            console.log("Please sign the following transaction on Ledger:", transaction);
            return await oldSignTransaction.apply(this, [transaction]);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ledgerWithAddress = await SignerWithAddress.create(ledger as any);
        hre.ethers.getSigners = async function () {
            return [ledgerWithAddress];
        };
    }
}
