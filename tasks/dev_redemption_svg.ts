import { strict as assert } from "assert";
import { task } from "hardhat/config";

task("dev_redemption_nft_metadata", "Generate a redemption NFT and print its metadata")
    .addParam("qSymbol", "QUEEN token's symbol")
    .addParam("underlyingSymbol", "Underlying token's symbol")
    .addParam("amountQ", "QUEEN token amount")
    .addParam("amountUnderlying", "Underlying token amount")
    .addFlag("image", "Print its token image")
    .setAction(async function (args, hre) {
        const { ethers } = hre;
        const { parseEther, parseUnits } = ethers.utils;

        assert.strictEqual(hre.network.name, "hardhat");

        const Descriptor = await ethers.getContractFactory("NonfungibleRedemptionDescriptor");
        const descriptor = await Descriptor.deploy(
            args.qSymbol,
            args.underlyingSymbol,
            6,
            0x8968b4,
            0x4956b7,
            0x8aa0ee,
            parseEther("1")
        );
        const params = [
            65432, // tokenId
            parseEther(args.amountQ),
            parseUnits(args.amountUnderlying, 6),
            ethers.BigNumber.from(
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdea"
            ), // seed
        ];
        const uri = await descriptor.tokenURI(...params);

        const HEADER = "data:application/json;base64,";
        assert.ok(uri.startsWith(HEADER));
        const metadata = JSON.parse(Buffer.from(uri.substring(HEADER.length), "base64").toString());
        const IMAGE_HEADER = "data:image/svg+xml;base64,";
        assert.ok(metadata.image.startsWith(IMAGE_HEADER));
        if (args.image) {
            console.log(
                Buffer.from(metadata.image.substring(IMAGE_HEADER.length), "base64").toString()
            );
        } else {
            console.log("Name:");
            console.log(metadata.name);
            console.log();
            console.log("Description:");
            console.log(metadata.description);
            console.log();
            console.log("Gas cost of tokenURI():");
            console.log((await descriptor.estimateGas.tokenURI(...params)).toNumber());
        }
    });
