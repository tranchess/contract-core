import { expect } from "chai";
import type { BigNumber, Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

export async function shouldBehaveLikeCastVote(
    ballot: Contract,
    votingEscrow: Contract,
    support: BigNumber,
    sender: SignerWithAddress,
    expectation: { revertMessage?: string; option?: BigNumber; weightedVotes?: BigNumber }
): Promise<void> {
    if (expectation.revertMessage) {
        await expect(castVote(ballot, support, sender)).to.be.revertedWith(
            expectation.revertMessage
        );
        return;
    }

    const option = await ballot.getOption(support);
    expect(option).to.equal(expectation.option);

    const beforeRound = await ballot.getRound();
    const beforeReceipt = await ballot.getReceipt(sender.address);
    const beforeVote = await ballot.voteDistribution(support);
    const beforeWeithedVote = await ballot.weightedVoteDistribution(support);

    await castVote(ballot, support, sender);

    const endTimestamp = (await ballot.getRound()).endTimestamp;
    const votes = await votingEscrow.balanceOfAtTimestamp(sender.address, endTimestamp);

    const afterRound = await ballot.getRound();
    const afterReceipt = await ballot.getReceipt(sender.address);
    const afterVote = await ballot.voteDistribution(support);
    const afterWeithedVote = await ballot.weightedVoteDistribution(support);

    expect(afterRound.totalVotes.sub(beforeRound.totalVotes)).to.equal(votes);
    expect(afterRound.totalValue.sub(beforeRound.totalValue)).to.equal(expectation.weightedVotes);

    expect(beforeReceipt.support).to.equal(0);
    expect(afterReceipt.support).to.equal(support);
    expect(afterReceipt.votes.sub(beforeReceipt.votes)).to.equal(votes);

    expect(afterVote.sub(beforeVote)).to.equal(votes);
    expect(afterWeithedVote.sub(beforeWeithedVote)).to.equal(expectation.weightedVotes);
}

async function castVote(ballot: Contract, support: BigNumber, sender: SignerWithAddress) {
    return ballot.connect(sender).castVote(support);
}

export async function ERC20Transfer(
    token: Contract,
    from: SignerWithAddress,
    to: SignerWithAddress,
    amount: BigNumber
): Promise<void> {
    await token.connect(from).transfer(to.address, amount);
}

export async function updateYesterdayPrice(
    twapOracle: Contract,
    price: BigNumber,
    sender: SignerWithAddress
): Promise<void> {
    await twapOracle.connect(sender).updateYesterdayPrice(price);
}

export async function createLock(
    votingEscrow: Contract,
    amount: BigNumber,
    lockedTime: BigNumber,
    sender: SignerWithAddress
): Promise<void> {
    await votingEscrow.connect(sender).createLock(amount, lockedTime);
}
