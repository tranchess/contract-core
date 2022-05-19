import { expect } from "chai";
import { BigNumber, BigNumberish, constants, Contract, Wallet } from "ethers";
import { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import { defaultAbiCoder } from "ethers/lib/utils";
import { TRANCHE_Q, TRANCHE_B, TRANCHE_R } from "./utils";

const UNIT = BigNumber.from(10).pow(18);
const n = BigNumber.from("2");
const n_n = n.pow(n);
const A = BigNumber.from("85");

function validate(amounts: BigNumber[], D: BigNumber, A: BigNumber, oracle: BigNumber) {
    const left = leftInvariant(amounts, D, A, oracle);
    const right = rightInvariant(amounts, D, A, oracle);

    // Meaure the relative difference of two numbers by taking their absolute difference divided by
    // the maximum absolute value of the two numbers
    expect(left.sub(right).mul(parseEther("1")).div(left)).to.be.at.most(parseEther("0.0001"));
}

function rightInvariant(
    amounts: BigNumber[],
    D: BigNumber,
    A: BigNumber,
    oracle: BigNumber
): BigNumber {
    const product = amounts[0].mul(amounts[1]).mul(oracle);
    return A.mul(D)
        .mul(n_n)
        .add(D.pow(n.add(1)).mul(UNIT).div(n_n.mul(product)));
}

function leftInvariant(
    amounts: BigNumber[],
    D: BigNumber,
    A: BigNumber,
    oracle: BigNumber
): BigNumber {
    const total = amounts[0].mul(oracle).div(UNIT).add(amounts[1]);
    return A.mul(total).mul(n_n).add(D);
}

const ONE = BigNumber.from(1);
const TWO = BigNumber.from(2);

function sqrt(value: BigNumber): BigNumber {
    const x = BigNumber.from(value);
    let z = x.add(ONE).div(TWO);
    let y = x;
    while (z.sub(y).isNegative()) {
        y = z;
        z = x.div(z).add(z).div(TWO);
    }
    return y;
}

function solveQuadratic(a: BigNumber, b: BigNumber, negC: BigNumber): BigNumber {
    const delta = b.pow(2).add(a.mul(negC).mul(4));
    return sqrt(delta).sub(b).mul(UNIT).div(a).div(2);
}

function getBase(
    A: BigNumber,
    newQuoteBalance: BigNumber,
    oracle: BigNumber,
    D: BigNumber
): BigNumber {
    const a = A.mul(newQuoteBalance).mul(16).mul(oracle).div(UNIT).mul(oracle).div(UNIT);
    const b = D.mul(newQuoteBalance)
        .div(UNIT)
        .mul(4)
        .add(newQuoteBalance.mul(A).mul(16).mul(newQuoteBalance).div(UNIT))
        .sub(D.mul(16).mul(A).mul(newQuoteBalance).div(UNIT))
        .mul(oracle)
        .div(UNIT);
    const negC = D.mul(D).div(UNIT).mul(D).div(UNIT);
    return solveQuadratic(a, b, negC);
}

function getQuote(
    A: BigNumber,
    newBaseBalance: BigNumber,
    oracle: BigNumber,
    D: BigNumber
): BigNumber {
    const a = A.mul(newBaseBalance).mul(16).mul(oracle).div(UNIT);
    const b = D.mul(newBaseBalance)
        .mul(4)
        .div(UNIT)
        .add(newBaseBalance.mul(16).mul(A).mul(newBaseBalance).div(UNIT).mul(oracle).div(UNIT))
        .sub(D.mul(16).mul(A).mul(newBaseBalance).div(UNIT))
        .mul(oracle)
        .div(UNIT);
    const negC = D.mul(D).div(UNIT).mul(D).div(UNIT);
    return solveQuadratic(a, b, negC);
}

describe("BishopStableSwap", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly fund: MockContract;
        readonly tokens: Contract[];
        readonly deadline: BigNumberish;
        readonly swapRouter: Contract;
        readonly lpToken: Contract;
        readonly stableSwap: Contract;
    }

    const FEE_RATE = parseEther("0.03");
    const ADMIN_FEE_RATE = parseEther("0.4");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let addr1: string;
    let addr2: string;
    let fund: MockContract;
    let tokens: Contract[];
    let deadline: BigNumberish;
    let swapRouter: Contract;
    let lpToken: Contract;
    let stableSwap: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

        const twapOracle = await deployMockForName(owner, "ITwapOracleV2");
        await twapOracle.mock.getLatest.returns(0);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(1);

        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.currentDay.returns(0);
        await fund.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("1"));
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.refreshBalance.returns();
        await fund.mock.twapOracle.returns(twapOracle.address);

        const MockToken = await ethers.getContractFactory("MockToken");
        const tokens = [
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
        ];
        await fund.mock.tokenShare.withArgs(TRANCHE_B).returns(tokens[0].address);
        await tokens[0].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[0].connect(owner).mint(user2.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user2.address, parseEther("1000"));

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        const chessController = await deployMockForName(owner, "ChessController");
        await chessSchedule.mock.getRate.returns(parseEther("1"));
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const swapBonus = await deployMockForName(owner, "SwapBonus");
        await swapBonus.mock.bonusToken.returns(ethers.constants.AddressZero);
        await swapBonus.mock.getBonus.returns(0);

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();

        const lpTokenAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 1,
        });
        const BishopStableSwap = await ethers.getContractFactory("BishopStableSwap");
        const stableSwap = await BishopStableSwap.connect(owner).deploy(
            lpTokenAddress,
            fund.address,
            tokens[1].address,
            18,
            A,
            owner.address,
            FEE_RATE,
            ADMIN_FEE_RATE,
            parseEther("0.35")
        );
        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const lpToken = await LiquidityGauge.connect(owner).deploy(
            "LP Token",
            "LP",
            stableSwap.address,
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address,
            swapBonus.address
        );

        await swapRouter.addSwap(tokens[0].address, tokens[1].address, stableSwap.address);

        await tokens[0].connect(user1).approve(swapRouter.address, parseEther("10"));
        await tokens[1].connect(user1).approve(swapRouter.address, parseEther("20"));

        await swapRouter
            .connect(user1)
            .addLiquidity(
                tokens[0].address,
                tokens[1].address,
                parseEther("10"),
                parseEther("10"),
                BigNumber.from("0"),
                0,
                deadline
            );

        return {
            wallets: { user1, user2, owner },
            fund,
            tokens,
            deadline,
            swapRouter: swapRouter.connect(user1),
            lpToken,
            stableSwap: stableSwap.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        addr1 = user1.address;
        addr2 = user2.address;
        deadline = fixtureData.deadline;
        swapRouter = fixtureData.swapRouter;
        fund = fixtureData.fund;
        tokens = fixtureData.tokens;
        lpToken = fixtureData.lpToken;
        stableSwap = fixtureData.stableSwap;
    });

    describe("buy()", function () {
        it("Should revert when trading curb", async function () {
            await fund.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("0.34"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));
            await expect(
                swapRouter.swapExactTokensForTokens(
                    parseEther("1"),
                    parseEther("1").div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            ).to.be.revertedWith("Trading curb");
        });

        it("Should buy", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969444922369433125");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getBaseOut(amount)).to.equal(dy);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    0,
                    amount,
                    dy,
                    0,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031537097903247411");
            const fee = dx.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getQuoteIn(amount)).to.equal(dx);

            await tokens[1].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    0,
                    dx,
                    amount,
                    0,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(dx).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(amount));
        });

        it("Should buy as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("808779627775290556");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect(await stableSwap.getBaseOut(amount)).to.equal(dy);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1210016884336529142");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect(await stableSwap.getBaseOut(amount)).to.equal(dy);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });
    });

    describe("sell()", function () {
        it("Should sell", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969427428100277828");
            const fee = BigNumber.from("29982291590730242");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getQuoteOut(amount)).to.equal(dy);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    amount,
                    0,
                    0,
                    dy,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031556347189852432");
            const amountBeforeFee = amount.mul(UNIT).div(UNIT.sub(FEE_RATE));
            const fee = amountBeforeFee.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getBaseIn(amount)).to.equal(dx);

            await tokens[0].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    dx,
                    0,
                    0,
                    amount,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(dx));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(amountBeforeFee).add(fee).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1161923892587227706");
            const fee = BigNumber.from("35935790492388485");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect(await stableSwap.getQuoteOut(amount)).to.equal(dy);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("776612943398956401");
            const fee = BigNumber.from("24018957012338857");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect(await stableSwap.getQuoteOut(amount)).to.equal(dy);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });
    });

    describe("addLiquidity()", function () {
        it("Should revert when trading curb", async function () {
            await fund.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("0.34"));
            await tokens[0].connect(user1).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));
            await expect(
                swapRouter.addLiquidity(
                    tokens[0].address,
                    tokens[1].address,
                    parseEther("1"),
                    parseEther("1"),
                    parseEther("0"),
                    0,
                    deadline
                )
            ).to.be.revertedWith("Trading curb");
        });

        it("Should add liquidity", async function () {
            await tokens[0].connect(user1).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));

            const beforeLP = await lpToken.balanceOf(addr1);
            await swapRouter.addLiquidity(
                tokens[0].address,
                tokens[1].address,
                parseEther("1"),
                parseEther("1"),
                parseEther("0"),
                0,
                deadline
            );
            const afterLP = await lpToken.balanceOf(addr1);
            expect(afterLP.sub(beforeLP)).to.equal(parseEther("2"));
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("11"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("11"));
        });
    });

    describe("removeLiquidity()", function () {
        beforeEach(async function () {
            await tokens[0].connect(user2).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user2).approve(swapRouter.address, parseEther("1"));

            await swapRouter
                .connect(user2)
                .addLiquidity(
                    tokens[0].address,
                    tokens[1].address,
                    parseEther("1"),
                    parseEther("1"),
                    parseEther("0"),
                    0,
                    deadline
                );
        });

        it("Should remove liquidity", async function () {
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap
                .connect(user2)
                .removeLiquidity(0, parseEther("2"), parseEther("1"), parseEther("1"));
            const afterLP = await lpToken.balanceOf(addr2);
            expect(beforeLP.sub(afterLP)).to.equal(parseEther("2"));
        });

        it("Should remove base liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newBaseBalance = getBase(A, parseEther("11"), oracle, afterD);
            newBaseBalance = parseEther("11");
            const newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .sub(parseEther("11").mul(afterD).div(beforeD))
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const baseDelta = newBaseBalance
                .sub(getBase(A, newQuoteBalance, oracle, afterD))
                .sub(1); // 452276567283981505

            const beforeToken = await tokens[0].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeBaseLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.be.closeTo(baseDelta, 1);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove base liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newBaseBalance = getBase(A, parseEther("11"), oracle, afterD);
            newBaseBalance = parseEther("11");
            const newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .sub(parseEther("11").mul(afterD).div(beforeD))
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const baseDelta = newBaseBalance
                .sub(getBase(A, newQuoteBalance, oracle, afterD))
                .sub(1); // 552673302281266301

            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeToken = await tokens[0].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeBaseLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.be.closeTo(baseDelta, 1);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newQuoteBalance = getQuote(A, parseEther("11"), oracle, afterD);
            newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .mul(afterD)
                    .div(beforeD)
                    .sub(newQuoteBalance)
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const newBaseBalance = parseEther("11");
            const quoteDelta = newQuoteBalance
                .sub(getQuote(A, newBaseBalance, oracle, afterD))
                .sub(1); // 540639941406019232

            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeQuoteLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newQuoteBalance = getQuote(A, parseEther("11"), oracle, afterD);
            newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .mul(afterD)
                    .div(beforeD)
                    .sub(newQuoteBalance)
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const newBaseBalance = parseEther("11");
            const quoteDelta = newQuoteBalance
                .sub(getQuote(A, newBaseBalance, oracle, afterD))
                .sub(1); // 444233504454156034

            await fund.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeQuoteLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });
    });
});

describe("QueenStableSwap", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly fund: MockContract;
        readonly tokens: Contract[];
        readonly deadline: BigNumberish;
        readonly swapRouter: Contract;
        readonly lpToken: Contract;
        readonly stableSwap: Contract;
    }

    const FEE_RATE = parseEther("0.03");
    const ADMIN_FEE_RATE = parseEther("0.4");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let addr1: string;
    let addr2: string;
    let fund: MockContract;
    let tokens: Contract[];
    let deadline: BigNumberish;
    let swapRouter: Contract;
    let lpToken: Contract;
    let stableSwap: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(1);

        const fund = await deployMockForName(owner, "IFundV3");
        await fund.mock.currentDay.returns(0);
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.refreshBalance.returns();
        await fund.mock.getTotalUnderlying.returns(parseEther("1"));
        await fund.mock.getEquivalentTotalQ.returns(parseEther("1"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const tokens = [
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
        ];
        await fund.mock.tokenUnderlying.returns(tokens[1].address);
        await fund.mock.underlyingDecimalMultiplier.returns(1);
        await fund.mock.tokenShare.withArgs(TRANCHE_Q).returns(tokens[0].address);
        await tokens[0].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[0].connect(owner).mint(user2.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user2.address, parseEther("1000"));

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        const chessController = await deployMockForName(owner, "ChessController");
        await chessSchedule.mock.getRate.returns(parseEther("1"));
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const swapBonus = await deployMockForName(owner, "SwapBonus");
        await swapBonus.mock.bonusToken.returns(ethers.constants.AddressZero);
        await swapBonus.mock.getBonus.returns(0);

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();

        const lpTokenAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 1,
        });
        const QueenStableSwap = await ethers.getContractFactory("QueenStableSwap");
        const stableSwap = await QueenStableSwap.connect(owner).deploy(
            lpTokenAddress,
            fund.address,
            18, // tokens[1].address,
            A,
            owner.address,
            FEE_RATE,
            ADMIN_FEE_RATE
        );
        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const lpToken = await LiquidityGauge.connect(owner).deploy(
            "LP Token",
            "LP",
            stableSwap.address,
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address,
            swapBonus.address
        );

        await swapRouter.addSwap(tokens[0].address, tokens[1].address, stableSwap.address);

        await tokens[0].connect(user1).approve(swapRouter.address, parseEther("10"));
        await tokens[1].connect(user1).approve(swapRouter.address, parseEther("20"));

        await swapRouter
            .connect(user1)
            .addLiquidity(
                tokens[0].address,
                tokens[1].address,
                parseEther("10"),
                parseEther("10"),
                BigNumber.from("0"),
                0,
                deadline
            );

        return {
            wallets: { user1, user2, owner },
            fund,
            tokens,
            deadline,
            swapRouter: swapRouter.connect(user1),
            lpToken,
            stableSwap: stableSwap.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        user2 = fixtureData.wallets.user2;
        addr1 = user1.address;
        addr2 = user2.address;
        deadline = fixtureData.deadline;
        swapRouter = fixtureData.swapRouter;
        fund = fixtureData.fund;
        tokens = fixtureData.tokens;
        lpToken = fixtureData.lpToken;
        stableSwap = fixtureData.stableSwap;
    });

    describe("buy()", function () {
        it("Should buy", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969444922369433125");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getBaseOut(amount)).to.equal(dy);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    0,
                    amount,
                    dy,
                    0,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031537097903247411");
            const fee = dx.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getQuoteIn(amount)).to.equal(dx);

            await tokens[1].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    0,
                    dx,
                    amount,
                    0,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(dx).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(amount));
        });

        it("Should buy as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("808779627775290556");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund.mock.getTotalUnderlying.returns(oracle);

            expect(await stableSwap.getBaseOut(amount)).to.equal(dy);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1210016884336529142");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund.mock.getTotalUnderlying.returns(oracle);

            expect(await stableSwap.getBaseOut(amount)).to.equal(dy);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });
    });

    describe("sell()", function () {
        it("Should sell", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969427428100277828");
            const fee = BigNumber.from("29982291590730242");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getQuoteOut(amount)).to.equal(dy);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    amount,
                    0,
                    0,
                    dy,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031556347189852432");
            const amountBeforeFee = amount.mul(UNIT).div(UNIT.sub(FEE_RATE));
            const fee = amountBeforeFee.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("10"));
            expect(await stableSwap.getBaseIn(amount)).to.equal(dx);

            await tokens[0].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            )
                .to.emit(stableSwap, "Swap")
                .withArgs(
                    swapRouter.address,
                    addr1,
                    dx,
                    0,
                    0,
                    amount,
                    fee,
                    adminFee,
                    parseEther("1")
                );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(dx));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(amountBeforeFee).add(fee).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1161923892587227706");
            const fee = BigNumber.from("35935790492388485");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund.mock.getTotalUnderlying.returns(oracle);

            expect(await stableSwap.getQuoteOut(amount)).to.equal(dy);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("776612943398956401");
            const fee = BigNumber.from("24018957012338857");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund.mock.getTotalUnderlying.returns(oracle);

            expect(await stableSwap.getQuoteOut(amount)).to.equal(dy);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    [0],
                    deadline
                )
            );

            const afterD = await stableSwap.getCurrentD();

            validate(await stableSwap.allBalances(), afterD, A, oracle);

            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });
    });

    describe("addLiquidity()", function () {
        it("Should add liquidity", async function () {
            await tokens[0].connect(user1).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));

            const beforeLP = await lpToken.balanceOf(addr1);
            await swapRouter.addLiquidity(
                tokens[0].address,
                tokens[1].address,
                parseEther("1"),
                parseEther("1"),
                parseEther("0"),
                0,
                deadline
            );
            const afterLP = await lpToken.balanceOf(addr1);
            expect(afterLP.sub(beforeLP)).to.equal(parseEther("2"));
            expect((await stableSwap.allBalances())[0]).to.equal(parseEther("11"));
            expect((await stableSwap.allBalances())[1]).to.equal(parseEther("11"));
        });
    });

    describe("removeLiquidity()", function () {
        beforeEach(async function () {
            await tokens[0].connect(user2).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user2).approve(swapRouter.address, parseEther("1"));

            await swapRouter
                .connect(user2)
                .addLiquidity(
                    tokens[0].address,
                    tokens[1].address,
                    parseEther("1"),
                    parseEther("1"),
                    parseEther("0"),
                    0,
                    deadline
                );
        });

        it("Should remove liquidity", async function () {
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap
                .connect(user2)
                .removeLiquidity(0, parseEther("2"), parseEther("1"), parseEther("1"));
            const afterLP = await lpToken.balanceOf(addr2);
            expect(beforeLP.sub(afterLP)).to.equal(parseEther("2"));
        });

        it("Should remove base liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newBaseBalance = getBase(A, parseEther("11"), oracle, afterD);
            newBaseBalance = parseEther("11");
            const newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .sub(parseEther("11").mul(afterD).div(beforeD))
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const baseDelta = newBaseBalance
                .sub(getBase(A, newQuoteBalance, oracle, afterD))
                .sub(1); // 452276567283981505

            const beforeToken = await tokens[0].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeBaseLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.be.closeTo(baseDelta, 1);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove base liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newBaseBalance = getBase(A, parseEther("11"), oracle, afterD);
            newBaseBalance = parseEther("11");
            const newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .sub(parseEther("11").mul(afterD).div(beforeD))
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const baseDelta = newBaseBalance
                .sub(getBase(A, newQuoteBalance, oracle, afterD))
                .sub(1); // 552673302281266301

            await fund.mock.getTotalUnderlying.returns(oracle);
            const beforeToken = await tokens[0].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeBaseLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.be.closeTo(baseDelta, 1);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newQuoteBalance = getQuote(A, parseEther("11"), oracle, afterD);
            newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .mul(afterD)
                    .div(beforeD)
                    .sub(newQuoteBalance)
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const newBaseBalance = parseEther("11");
            const quoteDelta = newQuoteBalance
                .sub(getQuote(A, newBaseBalance, oracle, afterD))
                .sub(1); // 540639941406019232

            await fund.mock.getTotalUnderlying.returns(oracle);
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeQuoteLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken.totalSupply();
            await fund.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap.getCurrentD();
            const afterD = beforeD.sub(beforeD.mul(burnAmount).div(lpSupply));
            let newQuoteBalance = getQuote(A, parseEther("11"), oracle, afterD);
            newQuoteBalance = parseEther("11").sub(
                parseEther("11")
                    .mul(afterD)
                    .div(beforeD)
                    .sub(newQuoteBalance)
                    .mul(FEE_RATE)
                    .div(UNIT)
            );
            const newBaseBalance = parseEther("11");
            const quoteDelta = newQuoteBalance
                .sub(getQuote(A, newBaseBalance, oracle, afterD))
                .sub(1); // 444233504454156034

            await fund.mock.getTotalUnderlying.returns(oracle);
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken.balanceOf(addr2);
            await stableSwap.connect(user2).removeQuoteLiquidity(0, burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });
    });
});

describe("Flash Swap", function () {
    const REDEMPTION_FEE_BPS = 35;
    const MERGE_FEE_BPS = 45;
    const TOTAL_UNDERLYING = parseBtc("10");
    const EQUIVALENT_TOTAL_Q = parseEther("10");
    const SPLIT_RATIO = parseEther("500");

    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly externalRouter: MockContract;
        readonly fund: MockContract;
        readonly primaryMarket: Contract;
        readonly primaryMarketRouter: Contract;
        readonly btc: Contract;
        readonly usd: Contract;
        readonly tokens: Contract[];
        readonly swapRouter: Contract;
        readonly stableSwap: Contract;
        readonly flashSwapRouter: Contract;
    }

    const FEE_RATE = parseEther("0.03");
    const ADMIN_FEE_RATE = parseEther("0.4");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let addr1: string;
    let externalRouter: MockContract;
    let fund: MockContract;
    let primaryMarket: Contract;
    let primaryMarketRouter: Contract;
    let tokens: Contract[];
    let btc: Contract;
    let usd: Contract;
    let swapRouter: Contract;
    let stableSwap: Contract;
    let flashSwapRouter: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

        const twapOracle = await deployMockForName(owner, "ITwapOracleV2");
        await twapOracle.mock.getLatest.returns(0);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.balanceOf.returns(0);
        await votingEscrow.mock.totalSupply.returns(1);

        const MockToken = await ethers.getContractFactory("MockToken");
        const tokens = [
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
        ];
        await tokens[0].connect(owner).mint(user1.address, parseEther("1000"));

        const btc = await MockToken.connect(owner).deploy("Wrapped BTC", "BTC", 8);
        const usd = await MockToken.connect(owner).deploy("USD", "USD", 18);
        await usd.connect(owner).mint(user1.address, parseEther("1000"));

        const fund = await deployMockForName(owner, "FundV3");
        await fund.mock.tokenShare.withArgs(TRANCHE_B).returns(tokens[0].address);
        await fund.mock.tokenUnderlying.returns(btc.address);
        await fund.mock.underlyingDecimalMultiplier.returns(1e10);
        await fund.mock.splitRatio.returns(SPLIT_RATIO);
        await fund.mock.getTotalUnderlying.returns(TOTAL_UNDERLYING);
        await fund.mock.getEquivalentTotalQ.returns(EQUIVALENT_TOTAL_Q);
        await fund.mock.currentDay.returns(0);
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.refreshBalance.returns();
        await fund.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("1"));
        await fund.mock.twapOracle.returns(twapOracle.address);
        await fund.mock.tokenB.returns(tokens[0].address);
        await fund.mock.tokenR.returns(tokens[1].address);
        await btc.mint(fund.address, TOTAL_UNDERLYING);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
            parseEther("0.0001").mul(MERGE_FEE_BPS),
            BigNumber.from(1).shl(256).sub(1)
        );
        await fund.mock.primaryMarket.returns(primaryMarket.address);

        const PrimaryMarketRouter = await ethers.getContractFactory("PrimaryMarketRouter");
        const primaryMarketRouter = await PrimaryMarketRouter.connect(owner).deploy(
            primaryMarket.address
        );

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        const chessController = await deployMockForName(owner, "ChessController");
        await chessSchedule.mock.getRate.returns(parseEther("1"));
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const externalRouter = await deployMockForName(owner, "IUniswapV2Router01");

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();

        const FlashSwapRouter = await ethers.getContractFactory("FlashSwapRouter");
        const flashSwapRouter = await FlashSwapRouter.connect(owner).deploy(swapRouter.address);
        await flashSwapRouter.toggleExternalRouter(externalRouter.address);

        const swapBonus = await deployMockForName(owner, "SwapBonus");
        await swapBonus.mock.bonusToken.returns(ethers.constants.AddressZero);
        await swapBonus.mock.getBonus.returns(0);

        const lpTokenAddress = ethers.utils.getContractAddress({
            from: owner.address,
            nonce: (await owner.getTransactionCount("pending")) + 1,
        });
        const BishopStableSwap = await ethers.getContractFactory("BishopStableSwap");
        const stableSwap = await BishopStableSwap.connect(owner).deploy(
            lpTokenAddress,
            fund.address,
            usd.address,
            18,
            A,
            owner.address,
            FEE_RATE,
            ADMIN_FEE_RATE,
            parseEther("0.35")
        );
        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        await LiquidityGauge.connect(owner).deploy(
            "LP Token",
            "LP",
            stableSwap.address,
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address,
            swapBonus.address
        );

        await swapRouter.addSwap(tokens[0].address, usd.address, stableSwap.address);

        await tokens[0].connect(user1).approve(swapRouter.address, parseEther("10"));
        await usd.connect(user1).approve(swapRouter.address, parseEther("20"));

        await swapRouter
            .connect(user1)
            .addLiquidity(
                tokens[0].address,
                usd.address,
                parseEther("10"),
                parseEther("10"),
                BigNumber.from("0"),
                0,
                deadline
            );

        return {
            wallets: { user1, user2, owner },
            externalRouter,
            fund,
            primaryMarket,
            primaryMarketRouter,
            btc,
            usd,
            tokens,
            swapRouter,
            stableSwap,
            flashSwapRouter: flashSwapRouter.connect(user1),
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        user1 = fixtureData.wallets.user1;
        addr1 = user1.address;
        swapRouter = fixtureData.swapRouter;
        stableSwap = fixtureData.stableSwap;
        flashSwapRouter = fixtureData.flashSwapRouter;
        externalRouter = fixtureData.externalRouter;
        fund = fixtureData.fund;
        primaryMarket = fixtureData.primaryMarket;
        primaryMarketRouter = fixtureData.primaryMarketRouter;
        btc = fixtureData.btc;
        usd = fixtureData.usd;
        tokens = fixtureData.tokens;
    });

    describe("tranchessSwapCallback()", function () {
        it("Should revert if call is not tranchess pair", async function () {
            const stableSwap1 = await deployMockForName(user1, "BishopStableSwap");
            await stableSwap1.mock.quoteAddress.returns(usd.address);
            await expect(
                stableSwap1.call(
                    flashSwapRouter,
                    "tranchessSwapCallback",
                    parseEther("1"),
                    0,
                    defaultAbiCoder.encode(
                        [
                            "address",
                            "address",
                            "uint256",
                            "address",
                            "uint256",
                            "address",
                            "address[]",
                        ],
                        [
                            primaryMarket.address,
                            primaryMarketRouter.address,
                            parseEther("1"),
                            addr1,
                            0,
                            externalRouter.address,
                            [usd.address, btc.address],
                        ]
                    )
                )
            ).to.be.revertedWith("Tranchess Pair check failed");
        });

        it("Should revert if it's bidirectional", async function () {
            const stableSwap1 = await deployMockForName(user1, "BishopStableSwap");
            await stableSwap1.mock.quoteAddress.returns(usd.address);
            await swapRouter.addSwap(tokens[0].address, usd.address, stableSwap1.address);
            await expect(
                stableSwap1.call(
                    flashSwapRouter,
                    "tranchessSwapCallback",
                    parseEther("1"),
                    parseEther("1"),
                    defaultAbiCoder.encode(
                        [
                            "address",
                            "address",
                            "uint256",
                            "address",
                            "uint256",
                            "address",
                            "address[]",
                        ],
                        [
                            primaryMarket.address,
                            primaryMarketRouter.address,
                            parseEther("1"),
                            addr1,
                            0,
                            externalRouter.address,
                            [usd.address, btc.address],
                        ]
                    )
                )
            ).to.be.revertedWith("Unidirectional check failed");
        });
    });

    describe("buyR()", function () {
        it("Should revert if insufficient input quote", async function () {
            const outR = parseEther("1");
            await externalRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await expect(
                flashSwapRouter
                    .connect(user1)
                    .buyR(
                        primaryMarket.address,
                        primaryMarketRouter.address,
                        parseEther("0.03"),
                        addr1,
                        usd.address,
                        externalRouter.address,
                        [usd.address, btc.address],
                        0,
                        outR
                    )
            ).to.be.revertedWith("Insufficient input");
        });

        it("Should buy with external swap", async function () {
            const outR = parseEther("1");
            const createdQ = outR.mul(parseEther("1")).div(SPLIT_RATIO);
            await fund.mock.trancheTransfer
                .withArgs(TRANCHE_B, stableSwap.address, outR, 0)
                .returns();
            await fund.mock.trancheTransfer.withArgs(TRANCHE_R, addr1, outR, 0).returns();
            await fund.mock.primaryMarketMint
                .withArgs(0, flashSwapRouter.address, createdQ, 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(0, flashSwapRouter.address, createdQ, 0)
                .returns();
            await fund.mock.primaryMarketMint
                .withArgs(1, flashSwapRouter.address, outR, 0)
                .returns();
            await fund.mock.primaryMarketMint
                .withArgs(2, flashSwapRouter.address, outR, 0)
                .returns();
            await externalRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await externalRouter.mock.swapExactTokensForTokens.returns([0, parseBtc("0.002")]);

            await btc.mint(flashSwapRouter.address, parseBtc("1"));
            await tokens[0].mint(stableSwap.address, outR);
            await usd
                .connect(user1)
                .approve(flashSwapRouter.address, BigNumber.from("30572571899722172"));
            await usd.mint(
                stableSwap.address,
                parseEther("1").sub(BigNumber.from("30572571899722172"))
            );

            const beforeQuote = await usd.balanceOf(user1.address);

            await flashSwapRouter
                .connect(user1)
                .buyR(
                    primaryMarket.address,
                    primaryMarketRouter.address,
                    parseEther("1"),
                    addr1,
                    usd.address,
                    externalRouter.address,
                    [usd.address, btc.address],
                    0,
                    outR
                );

            const afterQuote = await usd.balanceOf(user1.address);
            expect(afterQuote.sub(beforeQuote)).to.equal(BigNumber.from("-30572571899722172"));
        });
    });

    describe("sellR()", function () {
        it("Should revert if insufficient output quote", async function () {
            const inR = parseEther("1");
            const quoteAmount = parseEther("2");
            const mergeAmount = inR.mul(parseEther("1")).div(SPLIT_RATIO);
            const mergeFee = mergeAmount.mul(MERGE_FEE_BPS).div(10000);
            await fund.mock.trancheTransferFrom
                .withArgs(TRANCHE_R, addr1, flashSwapRouter.address, inR, 0)
                .returns();
            await fund.mock.trancheTransfer
                .withArgs(TRANCHE_Q, primaryMarketRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(1, flashSwapRouter.address, inR, 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(2, flashSwapRouter.address, inR, 0)
                .returns();
            await fund.mock.primaryMarketMint
                .withArgs(0, flashSwapRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await fund.mock.primaryMarketAddDebt
                .withArgs(0, mergeFee.mul(TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_Q))
                .returns();
            await fund.mock.trancheBalanceOf
                .withArgs(0, primaryMarketRouter.address)
                .returns(mergeAmount.sub(mergeFee));
            const redeemAmount = mergeAmount
                .sub(mergeFee)
                .mul(TOTAL_UNDERLYING)
                .div(EQUIVALENT_TOTAL_Q);
            const redeemFee = redeemAmount.mul(REDEMPTION_FEE_BPS).div(10000);
            await fund.mock.primaryMarketTransferUnderlying
                .withArgs(flashSwapRouter.address, redeemAmount.sub(redeemFee), redeemFee)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(0, primaryMarketRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await externalRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await externalRouter.mock.swapExactTokensForTokens.returns([0, quoteAmount]);
            await tokens[1].mint(addr1, inR);
            await tokens[1].connect(user1).approve(flashSwapRouter.address, inR);
            await usd.mint(flashSwapRouter.address, quoteAmount);

            await expect(
                flashSwapRouter
                    .connect(user1)
                    .sellR(
                        primaryMarket.address,
                        primaryMarketRouter.address,
                        parseEther("1.4"),
                        addr1,
                        usd.address,
                        externalRouter.address,
                        [btc.address, usd.address],
                        0,
                        inR
                    )
            ).to.be.revertedWith("Insufficient output");
        });

        it("Should sell with external swap", async function () {
            const inR = parseEther("1");
            const quoteAmount = parseEther("2");
            const mergeAmount = inR.mul(parseEther("1")).div(SPLIT_RATIO);
            const mergeFee = mergeAmount.mul(MERGE_FEE_BPS).div(10000);
            await fund.mock.trancheTransferFrom
                .withArgs(TRANCHE_R, addr1, flashSwapRouter.address, inR, 0)
                .returns();
            await fund.mock.trancheTransfer
                .withArgs(TRANCHE_Q, primaryMarketRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(1, flashSwapRouter.address, inR, 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(2, flashSwapRouter.address, inR, 0)
                .returns();
            await fund.mock.primaryMarketMint
                .withArgs(0, flashSwapRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await fund.mock.primaryMarketAddDebt
                .withArgs(0, mergeFee.mul(TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_Q))
                .returns();
            await fund.mock.trancheBalanceOf
                .withArgs(0, primaryMarketRouter.address)
                .returns(mergeAmount.sub(mergeFee));
            const redeemAmount = mergeAmount
                .sub(mergeFee)
                .mul(TOTAL_UNDERLYING)
                .div(EQUIVALENT_TOTAL_Q);
            const redeemFee = redeemAmount.mul(REDEMPTION_FEE_BPS).div(10000);
            await fund.mock.primaryMarketTransferUnderlying
                .withArgs(flashSwapRouter.address, redeemAmount.sub(redeemFee), redeemFee)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(0, primaryMarketRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await externalRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await externalRouter.mock.swapExactTokensForTokens.returns([0, quoteAmount]);

            await tokens[1].mint(flashSwapRouter.address, inR);
            await usd.mint(flashSwapRouter.address, quoteAmount);

            const beforeQuote = await usd.balanceOf(user1.address);

            await flashSwapRouter
                .connect(user1)
                .sellR(
                    primaryMarket.address,
                    primaryMarketRouter.address,
                    parseEther("0"),
                    addr1,
                    usd.address,
                    externalRouter.address,
                    [btc.address, usd.address],
                    0,
                    inR
                );

            const afterQuote = await usd.balanceOf(user1.address);
            expect(afterQuote.sub(beforeQuote)).to.equal(BigNumber.from("968462902096752589"));
        });
    });
});
