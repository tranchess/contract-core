import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

export async function advanceTimeAndBlock(targetTime: number): Promise<void> {
    const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
    const diff =
        targetTime > currentTimestamp % (24 * 60 * 60)
            ? targetTime - (currentTimestamp % (24 * 60 * 60))
            : 24 * 60 * 60 + targetTime - (currentTimestamp % (24 * 60 * 60));
    await ethers.provider.send("evm_mine", [currentTimestamp + diff]);
}

export async function shouldBehaveLikeCreate(
    primaryMarket: Contract,
    fund: Contract,
    tokenUnderlying: Contract,
    tokenP: Contract,
    underlyingAssets: BigNumber,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    if (expectation.shouldRevert) {
        await expect(create(primaryMarket, underlyingAssets, sender)).to.be.revertedWith(
            expectation.revertMessage
        );
        return;
    }

    const currentDay = await fund.currentDay();
    const shouldSetup = await primaryMarket.shouldSetup(currentDay);
    const shouldCumulate = await primaryMarket.shouldCumulate(sender.address, currentDay);

    if (expectation.shouldSetup) {
        expect(shouldSetup).to.equal(true);
    } else {
        expect(shouldSetup).to.equal(false);
    }
    if (expectation.shouldCumulate) {
        expect(shouldCumulate).to.equal(true);
    } else {
        expect(shouldCumulate).to.equal(false);
    }

    const beforeChess = await fund.getClaimableRewards(sender.address);
    const beforeBalance = await tokenUnderlying.balanceOf(fund.address);
    const beforeclaimablePShares = await primaryMarket.claimableSharesP(sender.address);
    const beforeclaimablePSharesOnHold = await primaryMarket.claimableSharesPOnHold(sender.address);
    const beforeClaimableUnderlyingAssets = await primaryMarket.claimableUnderlyingAssets(
        sender.address
    );
    const beforeClaimableUnderlyingAssetsOnHold = await primaryMarket.claimableUnderlyingAssetsOnHold(
        sender.address
    );
    const beforeTokenP = await tokenP.balanceOf(primaryMarket.address);

    await create(primaryMarket, underlyingAssets, sender);

    const afterChess = await fund.getClaimableRewards(sender.address);
    const afterBalance = await tokenUnderlying.balanceOf(fund.address);
    const afterClaimablePShares = await primaryMarket.claimableSharesP(sender.address);
    const afterClaimablePSharesOnHold = await primaryMarket.claimableSharesPOnHold(sender.address);
    const afterClaimableUnderlyingAssets = await primaryMarket.claimableUnderlyingAssets(
        sender.address
    );
    const afterClaimableUnderlyingAssetsOnHold = await primaryMarket.claimableUnderlyingAssetsOnHold(
        sender.address
    );
    const afterTokenP = await tokenP.balanceOf(primaryMarket.address);

    expect(afterChess.sub(beforeChess)).to.equal(expectation.rewards);
    expect(afterBalance.sub(beforeBalance)).to.equal(expectation.assetsDelta);
    expect(afterTokenP.sub(beforeTokenP)).to.equal(expectation.sharesDelta);

    if (shouldCumulate) {
        expect(afterClaimablePShares).to.equal(
            beforeclaimablePShares.add(beforeclaimablePSharesOnHold)
        );
        expect(afterClaimablePSharesOnHold).to.equal(expectation.sharesDelta);
        expect(afterClaimableUnderlyingAssets).to.equal(
            beforeClaimableUnderlyingAssets.add(beforeClaimableUnderlyingAssetsOnHold)
        );
        expect(afterClaimableUnderlyingAssetsOnHold).to.equal(0);
    } else {
        expect(afterClaimablePShares).to.equal(beforeclaimablePShares);
        expect(afterClaimablePSharesOnHold.sub(beforeclaimablePSharesOnHold)).to.equal(
            expectation.sharesDelta
        );
        expect(afterClaimableUnderlyingAssets).to.equal(beforeClaimableUnderlyingAssets);
        expect(afterClaimableUnderlyingAssetsOnHold).to.equal(
            beforeClaimableUnderlyingAssetsOnHold
        );
    }
}

export async function shouldBehaveLikeRedeem(
    fund: Contract,
    primaryMarket: Contract,
    tokenUnderlying: Contract,
    tokenP: Contract,
    sharesP: BigNumber,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    if (expectation.shouldRevert) {
        await expect(redeem(primaryMarket, sharesP, sender)).to.be.revertedWith(
            expectation.revertMessage
        );
        return;
    }

    const currentDay = await fund.currentDay();
    const shouldSetup = await primaryMarket.shouldSetup(currentDay);
    const shouldCumulate = await primaryMarket.shouldCumulate(sender.address, currentDay);

    if (expectation.shouldSetup) {
        expect(shouldSetup).to.equal(true);
    } else {
        expect(shouldSetup).to.equal(false);
    }
    if (expectation.shouldCumulate) {
        expect(shouldCumulate).to.equal(true);
    } else {
        expect(shouldCumulate).to.equal(false);
    }

    const beforeChess = await fund.getClaimableRewards(sender.address);
    const beforeBalance = await tokenUnderlying.balanceOf(sender.address);
    const beforeclaimablePShares = await primaryMarket.claimableSharesP(sender.address);
    const beforeclaimablePSharesOnHold = await primaryMarket.claimableSharesPOnHold(sender.address);
    const beforeClaimableUnderlyingAssets = await primaryMarket.claimableUnderlyingAssets(
        sender.address
    );
    const beforeClaimableUnderlyingAssetsOnHold = await primaryMarket.claimableUnderlyingAssetsOnHold(
        sender.address
    );
    const beforeTokenP = await tokenP.balanceOf(sender.address);

    await redeem(primaryMarket, sharesP, sender);

    const afterChess = await fund.getClaimableRewards(sender.address);
    const afterBalance = await tokenUnderlying.balanceOf(sender.address);
    const afterClaimablePShares = await primaryMarket.claimableSharesP(sender.address);
    const afterClaimablePSharesOnHold = await primaryMarket.claimableSharesPOnHold(sender.address);
    const afterClaimableUnderlyingAssets = await primaryMarket.claimableUnderlyingAssets(
        sender.address
    );
    const afterClaimableUnderlyingAssetsOnHold = await primaryMarket.claimableUnderlyingAssetsOnHold(
        sender.address
    );
    const afterTokenP = await tokenP.balanceOf(sender.address);

    expect(afterChess.sub(beforeChess)).to.equal(expectation.rewards);
    expect(afterBalance.sub(beforeBalance)).to.equal(0);
    expect(afterTokenP.sub(beforeTokenP)).to.equal(expectation.sharesDelta.mul(-1));

    if (shouldCumulate) {
        expect(afterClaimablePShares).to.equal(
            beforeclaimablePShares.add(beforeclaimablePSharesOnHold)
        );
        expect(afterClaimablePSharesOnHold).to.equal(0);
        expect(afterClaimableUnderlyingAssets).to.equal(
            beforeClaimableUnderlyingAssets.add(beforeClaimableUnderlyingAssetsOnHold)
        );
        expect(afterClaimableUnderlyingAssetsOnHold).to.equal(expectation.assetsDelta);
    } else {
        expect(afterClaimablePShares).to.equal(beforeclaimablePShares);
        expect(afterClaimablePSharesOnHold).to.equal(beforeclaimablePSharesOnHold);
        expect(afterClaimableUnderlyingAssets).to.equal(beforeClaimableUnderlyingAssets);
        expect(
            afterClaimableUnderlyingAssetsOnHold.sub(beforeClaimableUnderlyingAssetsOnHold)
        ).to.equal(expectation.assetsDelta);
    }
}

export async function shouldBehaveLikeClaim(
    fund: Contract,
    primaryMarket: Contract,
    governer: Contract,
    tokenUnderlying: Contract,
    tokenP: Contract,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    const currentDay = await fund.currentDay();
    const shouldCumulate = await primaryMarket.shouldCumulate(sender.address, currentDay);
    if (expectation.shouldCumulate) {
        expect(shouldCumulate).to.equal(true);
    } else {
        expect(shouldCumulate).to.equal(false);
    }

    const beforeChess = await fund.getClaimableRewards(sender.address);
    const beforeclaimablePSharesOnHold = await primaryMarket.claimableSharesPOnHold(sender.address);
    const beforeClaimableUnderlyingAssetsOnHold = await primaryMarket.claimableUnderlyingAssetsOnHold(
        sender.address
    );
    const beforeTokenP = await tokenP.balanceOf(sender.address);
    const beforeBalance = await tokenUnderlying.balanceOf(sender.address);
    const beforeFeeBalance = await tokenUnderlying.balanceOf(governer.address);

    await claim(primaryMarket, sender);

    const afterChess = await fund.getClaimableRewards(sender.address);
    const afterClaimablePShares = await primaryMarket.claimableSharesP(sender.address);
    const afterClaimablePSharesOnHold = await primaryMarket.claimableSharesPOnHold(sender.address);
    const afterClaimableUnderlyingAssets = await primaryMarket.claimableUnderlyingAssets(
        sender.address
    );
    const afterClaimableUnderlyingAssetsOnHold = await primaryMarket.claimableUnderlyingAssetsOnHold(
        sender.address
    );
    const afterTokenP = await tokenP.balanceOf(sender.address);
    const afterBalance = await tokenUnderlying.balanceOf(sender.address);
    const afterFeeBalance = await tokenUnderlying.balanceOf(governer.address);

    expect(afterChess.sub(beforeChess)).to.equal(expectation.rewards);
    expect(afterClaimablePShares).to.equal(0);
    expect(afterClaimableUnderlyingAssets).to.equal(0);
    expect(afterBalance.add(afterFeeBalance).sub(beforeBalance).sub(beforeFeeBalance)).to.equal(
        expectation.underlyingAssetsClaimed
    );
    expect(afterTokenP.sub(beforeTokenP)).to.equal(expectation.sharesPClaimed);

    if (shouldCumulate) {
        expect(afterClaimablePSharesOnHold).to.equal(0);
        expect(afterClaimableUnderlyingAssetsOnHold).to.equal(0);
    } else {
        expect(afterClaimablePSharesOnHold).to.equal(beforeclaimablePSharesOnHold);
        expect(afterClaimableUnderlyingAssetsOnHold).to.equal(
            beforeClaimableUnderlyingAssetsOnHold
        );
    }
}

export async function shouldBehaveLikeSplit(
    fund: Contract,
    primaryMarket: Contract,
    governer: Contract,
    tokenUnderlying: Contract,
    tokenP: Contract,
    tokenA: Contract,
    tokenB: Contract,
    sharesP: BigNumber,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    if (expectation.shouldRevert) {
        await expect(split(primaryMarket, sharesP, sender)).to.be.revertedWith(
            expectation.revertMessage
        );
        return;
    }

    const beforeChess = await fund.getClaimableRewards(sender.address);
    const beforeTokenP = await tokenP.balanceOf(sender.address);
    const beforeTokenA = await tokenA.balanceOf(sender.address);
    const beforeTokenB = await tokenB.balanceOf(sender.address);
    const beforeFeeBalance = await tokenUnderlying.balanceOf(governer.address);

    await split(primaryMarket, sharesP, sender);

    const afterChess = await fund.getClaimableRewards(sender.address);
    const afterTokenP = await tokenP.balanceOf(sender.address);
    const afterTokenA = await tokenA.balanceOf(sender.address);
    const afterTokenB = await tokenB.balanceOf(sender.address);
    const afterFeeBalance = await tokenUnderlying.balanceOf(governer.address);

    expect(afterChess.sub(beforeChess)).to.equal(expectation.rewards);
    expect(afterFeeBalance.sub(beforeFeeBalance)).to.equal(expectation.fee);
    expect(afterTokenP.sub(beforeTokenP)).to.equal(expectation.deltaP.mul(-1));
    expect(afterTokenA.sub(beforeTokenA)).to.equal(expectation.deltaA);
    expect(afterTokenB.sub(beforeTokenB)).to.equal(expectation.deltaB);
}

export async function shouldBehaveLikeMerge(
    fund: Contract,
    primaryMarket: Contract,
    governer: Contract,
    tokenUnderlying: Contract,
    tokenP: Contract,
    tokenA: Contract,
    tokenB: Contract,
    sharesA: BigNumber,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    if (expectation.shouldRevert) {
        await expect(merge(primaryMarket, sharesA, sender)).to.be.revertedWith(
            expectation.revertMessage
        );
        return;
    }

    const beforeChess = await fund.getClaimableRewards(sender.address);
    const beforeTokenP = await tokenP.balanceOf(sender.address);
    const beforeTokenA = await tokenA.balanceOf(sender.address);
    const beforeTokenB = await tokenB.balanceOf(sender.address);
    const beforeFeeBalance = await tokenUnderlying.balanceOf(governer.address);

    await merge(primaryMarket, sharesA, sender);

    const afterChess = await fund.getClaimableRewards(sender.address);
    const afterTokenP = await tokenP.balanceOf(sender.address);
    const afterTokenA = await tokenA.balanceOf(sender.address);
    const afterTokenB = await tokenB.balanceOf(sender.address);
    const afterFeeBalance = await tokenUnderlying.balanceOf(governer.address);

    expect(afterChess.sub(beforeChess)).to.equal(expectation.rewards);
    expect(afterFeeBalance.sub(beforeFeeBalance)).to.equal(expectation.fee);
    expect(afterTokenP.sub(beforeTokenP)).to.equal(expectation.deltaP);
    expect(afterTokenA.sub(beforeTokenA)).to.equal(expectation.deltaA.mul(-1));
    expect(afterTokenB.sub(beforeTokenB)).to.equal(expectation.deltaB.mul(-1));
}

export async function shouldBehaveLikeCheckConversion(
    primaryMarket: Contract,
    fund: Contract,
    governer: Contract,
    tokenUnderlying: Contract,
    tokenP: Contract,
    tokenA: Contract,
    tokenB: Contract,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    if (expectation.shouldRevert) {
        await expect(checkConversion(fund, sender)).to.be.revertedWith(expectation.revertMessage);
        return;
    }

    const shouldTrigger = await fund.shouldTriggerConversion();
    if (expectation.shouldTrigger) {
        expect(shouldTrigger).to.equal(true);
        const conversionMatrix = await fund.calculateConversion();
        expect(conversionMatrix.ratioP).to.equal(expectation.conversionMatrix.ratioP);
        expect(conversionMatrix.ratioA2P).to.equal(expectation.conversionMatrix.ratioA2P);
        expect(conversionMatrix.ratioB2P).to.equal(expectation.conversionMatrix.ratioB2P);
        expect(conversionMatrix.ratioAB).to.equal(expectation.conversionMatrix.ratioAB);
    } else {
        expect(shouldTrigger).to.equal(false);
    }

    const beforeChess = await fund.getClaimableRewards(primaryMarket.address);
    const beforeBalance = await tokenUnderlying.balanceOf(fund.address);
    const beforeFeeBalance = await tokenUnderlying.balanceOf(governer.address);
    const beforeBalanceConversion = await fund.mostRecentConversionBalances(sender.address);

    await checkConversion(fund, sender);

    const afterChess = await fund.getClaimableRewards(primaryMarket.address);
    const afterBalance = await tokenUnderlying.balanceOf(fund.address);
    const afterFeeBalance = await tokenUnderlying.balanceOf(governer.address);
    const afterBalanceConversion = await fund.mostRecentConversionBalances(sender.address);
    const afterNetAssetValues = await fund.getLatestNetAssetValues();

    if (expectation.shouldTrigger) {
        const afterSharesP = (await tokenP.balanceOf(sender.address)).add(
            await tokenP.balanceOf(sender.address)
        );
        const afterSharesA = (await tokenA.balanceOf(sender.address)).add(
            await tokenA.balanceOf(sender.address)
        );
        const afterSharesB = (await tokenB.balanceOf(sender.address)).add(
            await tokenB.balanceOf(sender.address)
        );
        expect(afterSharesP).to.equal(expectation.sharesP);
        expect(afterSharesA).to.equal(expectation.sharesA);
        expect(afterSharesB).to.equal(expectation.sharesB);

        const afterTotalSupplyP = await tokenP.totalSupply();
        const afterTotalSupplyA = await tokenA.totalSupply();
        const afterTotalSupplyB = await tokenB.totalSupply();

        expect(afterTotalSupplyP).to.equal(expectation.totalSupplyP);
        expect(afterTotalSupplyA).to.equal(expectation.totalSupplyA);
        expect(afterTotalSupplyB).to.equal(expectation.totalSupplyB);
    }

    expect(afterChess.sub(beforeChess)).to.equal(expectation.rewards);
    expect(afterBalance.sub(beforeBalance)).to.equal(expectation.fee.mul(-1));
    expect(afterFeeBalance.sub(beforeFeeBalance)).to.equal(expectation.fee);
    expect(afterBalanceConversion).to.equal(beforeBalanceConversion);

    expect(afterNetAssetValues.P).to.equal(expectation.netAssetValues.P);
    expect(afterNetAssetValues.A).to.equal(expectation.netAssetValues.A);
}

export async function shouldBehaveLikeConvertAllowance(
    operator: SignerWithAddress,
    fund: Contract,
    sharesP: Contract,
    sharesA: Contract,
    sharesB: Contract,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    await fund.connect(sender).convertAllowance(sender.address, operator.address, 10);

    const afterAllowanceP = await sharesP.allowance(sender.address, operator.address);
    const afterAllowanceA = await sharesA.allowance(sender.address, operator.address);
    const afterAllowanceB = await sharesB.allowance(sender.address, operator.address);

    expect(afterAllowanceP).to.equal(expectation.allowanceP);
    expect(afterAllowanceA).to.equal(expectation.allowanceA);
    expect(afterAllowanceB).to.equal(expectation.allowanceB);
}

export async function shouldBehaveLikeClaimRewards(
    fund: Contract,
    chess: Contract,
    sender: SignerWithAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    expectation: any
): Promise<void> {
    const beforeChess = await chess.balanceOf(sender.address);

    claimRewards(fund, sender);

    const afterChess = await chess.balanceOf(sender.address);

    expect(afterChess.sub(beforeChess)).to.equal(expectation.rewards);
}

export async function chessStatistics(
    fund: Contract,
    primaryMarket: Contract,
    chess: Contract,
    users: SignerWithAddress[]
): Promise<void> {
    const totalRewards = (await fund.getClaimableRewards(users[0].address))
        .add(await fund.getClaimableRewards(users[1].address))
        .add(await fund.getClaimableRewards(users[2].address))
        .add(await fund.getClaimableRewards(users[3].address))
        .add(await fund.getClaimableRewards(primaryMarket.address))
        .add(await chess.balanceOf(users[0].address))
        .add(await chess.balanceOf(users[1].address))
        .add(await chess.balanceOf(users[2].address))
        .add(await chess.balanceOf(users[3].address))
        .add(await chess.balanceOf(primaryMarket.address));
    console.log("current chess:", totalRewards.toString());
}

async function claimRewards(fund: Contract, sender: SignerWithAddress) {
    return fund.connect(sender).claimRewards(sender.address);
}

async function create(
    primaryMarket: Contract,
    underlyingAssets: BigNumber,
    sender: SignerWithAddress
) {
    return primaryMarket.connect(sender).create(underlyingAssets);
}

async function redeem(primaryMarket: Contract, sharesP: BigNumber, sender: SignerWithAddress) {
    return primaryMarket.connect(sender).redeem(sharesP);
}

async function claim(primaryMarket: Contract, sender: SignerWithAddress) {
    return primaryMarket.connect(sender).claim();
}

async function split(primaryMarket: Contract, sharesP: BigNumber, sender: SignerWithAddress) {
    return primaryMarket.connect(sender).split(sharesP);
}

async function merge(primaryMarket: Contract, sharesA: BigNumber, sender: SignerWithAddress) {
    return primaryMarket.connect(sender).merge(sharesA);
}

export async function updatePrice(
    twapOracle: Contract,
    timestamp: BigNumber,
    price: BigNumber,
    sender: SignerWithAddress
): Promise<void> {
    await twapOracle.connect(sender).updatePrice(timestamp, price);
}

export async function updateYesterdayPrice(
    twapOracle: Contract,
    price: BigNumber,
    sender: SignerWithAddress
): Promise<void> {
    await twapOracle.connect(sender).updateYesterdayPrice(price);
}

async function checkConversion(fund: Contract, sender: SignerWithAddress) {
    return fund.connect(sender).checkConversion();
}

export async function ERC20Mint(
    token: Contract,
    from: SignerWithAddress,
    to: SignerWithAddress,
    amount: BigNumber
): Promise<void> {
    await token.connect(from).mint(to.address, amount);
}

export async function ERC20Approve(
    token: Contract,
    from: SignerWithAddress,
    to: SignerWithAddress | Contract,
    amount: BigNumber
): Promise<void> {
    await token.connect(from).approve(to.address, amount);
}
