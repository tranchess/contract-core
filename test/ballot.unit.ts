import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";
const { parseEther } = ethers.utils;
import { ERC20Approve } from "./primary_market.behavior";
import {
    ERC20Transfer,
    createLock,
    updateYesterdayPrice,
    shouldBehaveLikeCastVote,
} from "./ballot.behavior";
import { parseUnits } from "ethers/lib/utils";

describe("ballot", function () {
    let sender: SignerWithAddress;
    let user1: SignerWithAddress;
    let governance: SignerWithAddress;
    let fund: Contract;
    let twapOracle: Contract;
    let chess: Contract;
    let votingEscrow: Contract;
    let ballot: Contract;

    before(async function () {
        [sender, user1, governance] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockToken");
        const tokenUnderlying = await MockToken.deploy("ERC20", "ERC20", 8);

        const MockTwapOracle = await ethers.getContractFactory("MockTwapOracle");
        twapOracle = await MockTwapOracle.deploy();

        const Fund = await ethers.getContractFactory("Fund");
        fund = await Fund.deploy(
            parseEther("0.01"),
            parseEther("1.5"),
            parseEther("0.5"),
            parseEther("1.1"),
            twapOracle.address
        );

        const Chess = await ethers.getContractFactory("Chess");
        chess = await Chess.deploy();

        const VotingEscrow = await ethers.getContractFactory("VotingEscrow");
        votingEscrow = await VotingEscrow.deploy(
            chess.address,
            ethers.constants.AddressZero,
            "veChess",
            "veChess"
        );
        await chess.addMinter(sender.address);

        await ERC20Transfer(chess, sender, user1, parseEther("1"));
        await ERC20Approve(chess, user1, votingEscrow, parseEther("1"));
        const startTime = (await ethers.provider.getBlock("latest")).timestamp;
        await createLock(
            votingEscrow,
            parseEther("1"),
            BigNumber.from(startTime + 4 * 365 * 86400),
            user1
        );

        const MockAprOracle = await ethers.getContractFactory("MockAprOracle");
        const aprOracle = await MockAprOracle.deploy();
        await aprOracle.setRate(0);

        const Share = await ethers.getContractFactory("Share");
        const tokenP = await Share.deploy("ERC20", "ERC20", fund.address, 0);
        const tokenA = await Share.deploy("ERC20", "ERC20", fund.address, 1);
        const tokenB = await Share.deploy("ERC20", "ERC20", fund.address, 2);

        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarket");
        const primaryMarket = await PrimaryMarket.deploy(
            fund.address,
            parseEther("0.0001"),
            parseEther("0.001"),
            parseEther("0.001"),
            parseEther("0.001"),
            parseUnits("0.5", 8)
        );

        const InterestRateBallot = await ethers.getContractFactory("InterestRateBallot");
        ballot = await InterestRateBallot.deploy(votingEscrow.address, fund.address);

        await updateYesterdayPrice(twapOracle, parseEther("1"), sender);
        await tokenUnderlying.mint(sender.address, parseUnits("1", 8));
        await tokenUnderlying.approve(primaryMarket.address, parseUnits("1", 8));
        await fund.initialize(
            tokenUnderlying.address,
            8,
            tokenP.address,
            tokenA.address,
            tokenB.address,
            aprOracle.address,
            ballot.address,
            primaryMarket.address,
            governance.address
        );
    });

    context("unit", function () {
        describe("day 0", function () {
            it(`should revert due to invalid option`, async () => {
                const support = BigNumber.from("9");
                await shouldBehaveLikeCastVote(ballot, votingEscrow, support, user1, {
                    revertMessage: "Governance::_castVote: invalid option",
                });
            });

            it(`should cast vote`, async () => {
                const support = BigNumber.from("0");
                await shouldBehaveLikeCastVote(ballot, votingEscrow, support, user1, {
                    option: BigNumber.from("0"),
                    weightedVotes: BigNumber.from("0"),
                });
            });

            it(`should revert due to already voted`, async () => {
                const support = BigNumber.from("1");
                await shouldBehaveLikeCastVote(ballot, votingEscrow, support, user1, {
                    revertMessage: "Governance::_castVote: voter already voted",
                });
            });
        });
    });
});
