import { expect } from "chai";
import { BigNumber, BigNumberish, constants, Contract, Wallet } from "ethers";
import { Fixture, MockContract, MockProvider } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
const { parseEther, parseUnits } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { deployMockForName } from "./mock";
import { defaultAbiCoder } from "ethers/lib/utils";

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

describe("StableSwapRebalance", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly fund0: MockContract;
        readonly fund1: MockContract;
        readonly tokens: Contract[];
        readonly deadline: BigNumberish;
        readonly swapRouter: Contract;
        readonly lpToken0: Contract;
        readonly stableSwap0: Contract;
        readonly lpToken1: Contract;
        readonly stableSwap1: Contract;
    }

    const FEE_RATE = parseEther("0.03");
    const ADMIN_FEE_RATE = parseEther("0.4");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let addr1: string;
    let addr2: string;
    let fund0: MockContract;
    let tokens: Contract[];
    let deadline: BigNumberish;
    let swapRouter: Contract;
    let lpToken0: Contract;
    let stableSwap0: Contract;
    //let stableSwap1: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

        const aggregator = await deployMockForName(owner, "AggregatorV3Interface");
        await aggregator.mock.latestRoundData.returns(0, 0, 0, 0, 0);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.getLockedBalance.returns([0, 0]);

        const fund0 = await deployMockForName(owner, "IFundV3");
        const fund1 = await deployMockForName(owner, "IFundV3");
        const primaryMarket0 = await deployMockForName(owner, "IPrimaryMarketV3");
        const primaryMarket1 = await deployMockForName(owner, "IPrimaryMarketV3");
        await fund0.mock.currentDay.returns(0);
        await fund0.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("1"));
        await fund0.mock.getRebalanceSize.returns(0);
        await fund0.mock.refreshBalance.returns();
        await fund1.mock.currentDay.returns(0);
        await fund1.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("1"));
        await fund1.mock.getRebalanceSize.returns(0);
        await fund1.mock.refreshBalance.returns();

        const MockToken = await ethers.getContractFactory("MockToken");
        const tokens = [
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
        ];
        await tokens[0].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[2].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[0].connect(owner).mint(user2.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user2.address, parseEther("1000"));
        await tokens[2].connect(owner).mint(user2.address, parseEther("1000"));

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        const chessController = await deployMockForName(owner, "ChessController");
        await chessSchedule.mock.getRate.returns(parseEther("1"));
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const lpToken0 = await LiquidityGauge.connect(owner).deploy(
            "pool2 token",
            "pool2 token",
            chessSchedule.address,
            chessController.address,
            fund0.address,
            votingEscrow.address
        );
        const lpToken1 = await LiquidityGauge.connect(owner).deploy(
            "pool2 token",
            "pool2 token",
            chessSchedule.address,
            chessController.address,
            fund1.address,
            votingEscrow.address
        );

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();

        const StableSwapRebalance = await ethers.getContractFactory("StableSwapRebalance");
        const stableSwap0 = await StableSwapRebalance.connect(owner).deploy(
            fund0.address,
            primaryMarket0.address,
            lpToken0.address,
            tokens[0].address,
            tokens[1].address,
            A,
            A,
            owner.address,
            FEE_RATE,
            ADMIN_FEE_RATE,
            aggregator.address,
            parseEther("0.35")
        );
        const stableSwap1 = await StableSwapRebalance.connect(owner).deploy(
            fund1.address,
            primaryMarket1.address,
            lpToken1.address,
            tokens[2].address,
            tokens[1].address,
            A,
            A,
            owner.address,
            FEE_RATE,
            ADMIN_FEE_RATE,
            aggregator.address,
            parseEther("0.35")
        );

        await swapRouter.addSwap(tokens[0].address, tokens[1].address, stableSwap0.address);
        await swapRouter.addSwap(tokens[2].address, tokens[1].address, stableSwap1.address);

        await lpToken0.transferOwnership(stableSwap0.address);
        await lpToken1.transferOwnership(stableSwap1.address);
        await tokens[0].connect(user1).approve(swapRouter.address, parseEther("10"));
        await tokens[1].connect(user1).approve(swapRouter.address, parseEther("20"));
        await tokens[2].connect(user1).approve(swapRouter.address, parseEther("10"));

        await swapRouter
            .connect(user1)
            .addLiquidity(
                tokens[0].address,
                tokens[1].address,
                parseEther("10"),
                parseEther("10"),
                BigNumber.from("0"),
                deadline
            );
        await swapRouter
            .connect(user1)
            .addLiquidity(
                tokens[2].address,
                tokens[1].address,
                parseEther("10"),
                parseEther("10"),
                BigNumber.from("0"),
                deadline
            );

        return {
            wallets: { user1, user2, owner },
            fund0,
            fund1,
            tokens,
            deadline,
            swapRouter: swapRouter.connect(user1),
            lpToken0,
            stableSwap0: stableSwap0.connect(user1),
            lpToken1,
            stableSwap1: stableSwap1.connect(user1),
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
        fund0 = fixtureData.fund0;
        tokens = fixtureData.tokens;
        lpToken0 = fixtureData.lpToken0;
        stableSwap0 = fixtureData.stableSwap0;
        //stableSwap1 = fixtureData.stableSwap1;
    });

    describe("buy()", function () {
        it("Should revert when trading curb", async function () {
            await fund0.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("0.34"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));
            await expect(
                swapRouter.swapExactTokensForTokens(
                    parseEther("1"),
                    parseEther("1").div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            ).to.be.revertedWith("Trading curb");
        });

        it("Should buy", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969444922369433127");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getBaseDeltaOut(amount)).baseDelta).to.equal(dy);
            expect((await stableSwap0.getBaseDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, dy, 0, 0, amount, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031537097903247409");
            const fee = dx.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getQuoteDeltaIn(amount)).quoteDelta).to.equal(dx);
            expect((await stableSwap0.getQuoteDeltaIn(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaIn(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, amount, 0, 0, dx, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(dx).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(amount));
        });

        it("Should buy as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("808779627775290556");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect((await stableSwap0.getBaseDeltaOut(amount)).baseDelta).to.equal(dy);
            expect((await stableSwap0.getBaseDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1210016884336529142");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect((await stableSwap0.getBaseDeltaOut(amount)).baseDelta).to.equal(dy);
            expect((await stableSwap0.getBaseDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });
    });

    describe("sell()", function () {
        it("Should sell", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969427428100277830");
            const fee = BigNumber.from("29982291590730242");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getQuoteDeltaOut(amount)).quoteDelta).to.equal(dy);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, 0, dy, amount, 0, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031556347189852430");
            const amountBeforeFee = amount.mul(UNIT).div(UNIT.sub(FEE_RATE));
            const fee = amountBeforeFee.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getBaseDeltaIn(amount)).baseDelta).to.equal(dx);
            expect((await stableSwap0.getBaseDeltaIn(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaIn(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, 0, amount, dx, 0, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(dx));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(amountBeforeFee).add(fee).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1161923892587227706");
            const fee = BigNumber.from("35935790492388485");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect((await stableSwap0.getQuoteDeltaOut(amount)).quoteDelta).to.equal(dy);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("776612943398956402");
            const fee = BigNumber.from("24018957012338857");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));

            expect((await stableSwap0.getQuoteDeltaOut(amount)).quoteDelta).to.equal(dy);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });
    });

    describe("addLiquidity()", function () {
        it("Should revert when trading curb", async function () {
            await fund0.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("0.34"));
            await tokens[0].connect(user1).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));
            await expect(
                swapRouter.addLiquidity(
                    tokens[0].address,
                    tokens[1].address,
                    parseEther("1"),
                    parseEther("1"),
                    parseEther("0"),
                    deadline
                )
            ).to.be.revertedWith("Trading curb");
        });

        it("Should add liquidity", async function () {
            await tokens[0].connect(user1).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));

            const beforeLP = await lpToken0.balanceOf(addr1);
            await swapRouter.addLiquidity(
                tokens[0].address,
                tokens[1].address,
                parseEther("1"),
                parseEther("1"),
                parseEther("0"),
                deadline
            );
            const afterLP = await lpToken0.balanceOf(addr1);
            expect(afterLP.sub(beforeLP)).to.equal(parseEther("2"));
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("11"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("11"));
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
                    deadline
                );
        });

        it("Should remove liquidity", async function () {
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0
                .connect(user2)
                .removeLiquidity(parseEther("1"), parseEther("1"), parseEther("2"));
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(beforeLP.sub(afterLP)).to.equal(parseEther("2"));
        });

        it("Should remove base liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap0.getCurrentD();
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
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeBaseLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(baseDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove base liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap0.getCurrentD();
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

            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeToken = await tokens[0].balanceOf(addr2);
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeBaseLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(baseDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap0.getCurrentD();
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

            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeQuoteLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeD = await stableSwap0.getCurrentD();
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

            await fund0.mock.extrapolateNav.returns(0, oracle, parseEther("1"));
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeQuoteLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });
    });
});

describe("StableSwapNoRebalance", function () {
    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly fund0: MockContract;
        readonly tokens: Contract[];
        readonly deadline: BigNumberish;
        readonly swapRouter: Contract;
        readonly lpToken0: Contract;
        readonly stableSwap0: Contract;
    }

    const FEE_RATE = parseEther("0.03");
    const ADMIN_FEE_RATE = parseEther("0.4");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let user2: Wallet;
    let addr1: string;
    let addr2: string;
    let fund0: MockContract;
    let tokens: Contract[];
    let deadline: BigNumberish;
    let swapRouter: Contract;
    let lpToken0: Contract;
    let stableSwap0: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.getLockedBalance.returns([0, 0]);

        const fund0 = await deployMockForName(owner, "IFundV3");
        const primaryMarket0 = await deployMockForName(owner, "IPrimaryMarketV3");
        await fund0.mock.currentDay.returns(0);
        await fund0.mock.getRebalanceSize.returns(0);
        await fund0.mock.refreshBalance.returns();
        await fund0.mock.getTotalUnderlying.returns(parseEther("1"));
        await fund0.mock.getEquivalentTotalM.returns(parseEther("1"));

        const MockToken = await ethers.getContractFactory("MockToken");
        const tokens = [
            await MockToken.connect(owner).deploy("token", "token", 18),
            await MockToken.connect(owner).deploy("token", "token", 18),
        ];
        await tokens[0].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user1.address, parseEther("1000"));
        await tokens[0].connect(owner).mint(user2.address, parseEther("1000"));
        await tokens[1].connect(owner).mint(user2.address, parseEther("1000"));

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        const chessController = await deployMockForName(owner, "ChessController");
        await chessSchedule.mock.getRate.returns(parseEther("1"));
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const lpToken0 = await LiquidityGauge.connect(owner).deploy(
            "pool2 token",
            "pool2 token",
            chessSchedule.address,
            chessController.address,
            fund0.address,
            votingEscrow.address
        );

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();

        const StableSwapNoRebalance = await ethers.getContractFactory("StableSwapNoRebalance");
        const stableSwap0 = await StableSwapNoRebalance.connect(owner).deploy(
            fund0.address,
            primaryMarket0.address,
            lpToken0.address,
            tokens[0].address,
            tokens[1].address,
            A,
            A,
            owner.address,
            FEE_RATE,
            ADMIN_FEE_RATE
        );

        await swapRouter.addSwap(tokens[0].address, tokens[1].address, stableSwap0.address);

        await lpToken0.transferOwnership(stableSwap0.address);
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
                deadline
            );

        return {
            wallets: { user1, user2, owner },
            fund0,
            tokens,
            deadline,
            swapRouter: swapRouter.connect(user1),
            lpToken0,
            stableSwap0: stableSwap0.connect(user1),
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
        fund0 = fixtureData.fund0;
        tokens = fixtureData.tokens;
        lpToken0 = fixtureData.lpToken0;
        stableSwap0 = fixtureData.stableSwap0;
        //stableSwap1 = fixtureData.stableSwap1;
    });

    describe("buy()", function () {
        it("Should buy", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969444922369433127");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getBaseDeltaOut(amount)).baseDelta).to.equal(dy);
            expect((await stableSwap0.getBaseDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, dy, 0, 0, amount, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031537097903247409");
            const fee = dx.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getQuoteDeltaIn(amount)).quoteDelta).to.equal(dx);
            expect((await stableSwap0.getQuoteDeltaIn(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaIn(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, amount, 0, 0, dx, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(dx).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(amount));
        });

        it("Should buy as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("808779627775290556");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund0.mock.getTotalUnderlying.returns(oracle);

            expect((await stableSwap0.getBaseDeltaOut(amount)).baseDelta).to.equal(dy);
            expect((await stableSwap0.getBaseDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });

        it("Should buy as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1210016884336529142");
            const fee = amount.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund0.mock.getTotalUnderlying.returns(oracle);

            expect((await stableSwap0.getBaseDeltaOut(amount)).baseDelta).to.equal(dy);
            expect((await stableSwap0.getBaseDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[1].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[1].address, tokens[0].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").add(amount).sub(adminFee)
            );
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").sub(dy));
        });
    });

    describe("sell()", function () {
        it("Should sell", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("969427428100277830");
            const fee = BigNumber.from("29982291590730242");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getQuoteDeltaOut(amount)).quoteDelta).to.equal(dy);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, 0, dy, amount, 0, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell exact", async function () {
            const amount = parseEther("1");
            const dx = BigNumber.from("1031556347189852430");
            const amountBeforeFee = amount.mul(UNIT).div(UNIT.sub(FEE_RATE));
            const fee = amountBeforeFee.mul(FEE_RATE).div(UNIT);
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("10"));
            expect((await stableSwap0.getBaseDeltaIn(amount)).baseDelta).to.equal(dx);
            expect((await stableSwap0.getBaseDeltaIn(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getBaseDeltaIn(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, dx);
            await expect(
                swapRouter.swapTokensForExactTokens(
                    amount,
                    amount.mul(2),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            )
                .to.emit(stableSwap0, "Swap")
                .withArgs(swapRouter.address, 0, amount, dx, 0, addr1);

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, parseEther("1"));

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(dx));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(amountBeforeFee).add(fee).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts up", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("1161923892587227706");
            const fee = BigNumber.from("35935790492388485");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("1.2");
            await fund0.mock.getTotalUnderlying.returns(oracle);

            expect((await stableSwap0.getQuoteDeltaOut(amount)).quoteDelta).to.equal(dy);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });

        it("Should sell as oracle shifts down", async function () {
            const amount = parseEther("1");
            const dy = BigNumber.from("776612943398956402");
            const fee = BigNumber.from("24018957012338857");
            const adminFee = fee.mul(ADMIN_FEE_RATE).div(UNIT);

            const oracle = parseEther("0.8");
            await fund0.mock.getTotalUnderlying.returns(oracle);

            expect((await stableSwap0.getQuoteDeltaOut(amount)).quoteDelta).to.equal(dy);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).fee).to.equal(fee);
            expect((await stableSwap0.getQuoteDeltaOut(amount)).adminFee).to.equal(adminFee);

            await tokens[0].connect(user1).approve(swapRouter.address, amount);
            await expect(
                swapRouter.swapExactTokensForTokens(
                    amount,
                    amount.div(100),
                    [tokens[0].address, tokens[1].address],
                    addr1,
                    constants.AddressZero,
                    deadline
                )
            );

            const afterD = await stableSwap0.getCurrentD();

            validate(await stableSwap0.allBalances(), afterD, A, oracle);

            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("10").add(amount));
            expect((await stableSwap0.allBalances())[1]).to.equal(
                parseEther("10").sub(dy).sub(adminFee)
            );
        });
    });

    describe("addLiquidity()", function () {
        it("Should add liquidity", async function () {
            await tokens[0].connect(user1).approve(swapRouter.address, parseEther("1"));
            await tokens[1].connect(user1).approve(swapRouter.address, parseEther("1"));

            const beforeLP = await lpToken0.balanceOf(addr1);
            await swapRouter.addLiquidity(
                tokens[0].address,
                tokens[1].address,
                parseEther("1"),
                parseEther("1"),
                parseEther("0"),
                deadline
            );
            const afterLP = await lpToken0.balanceOf(addr1);
            expect(afterLP.sub(beforeLP)).to.equal(parseEther("2"));
            expect((await stableSwap0.allBalances())[0]).to.equal(parseEther("11"));
            expect((await stableSwap0.allBalances())[1]).to.equal(parseEther("11"));
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
                    deadline
                );
        });

        it("Should remove liquidity", async function () {
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0
                .connect(user2)
                .removeLiquidity(parseEther("1"), parseEther("1"), parseEther("2"));
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(beforeLP.sub(afterLP)).to.equal(parseEther("2"));
        });

        it("Should remove base liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap0.getCurrentD();
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
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeBaseLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(baseDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove base liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap0.getCurrentD();
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

            await fund0.mock.getTotalUnderlying.returns(oracle);
            const beforeToken = await tokens[0].balanceOf(addr2);
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeBaseLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[0].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(baseDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts up", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("1.2");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap0.getCurrentD();
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

            await fund0.mock.getTotalUnderlying.returns(oracle);
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeQuoteLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });

        it("Should remove quote liquidity when oracle shifts down", async function () {
            const burnAmount = parseEther("0.5");
            const oracle = parseEther("0.8");
            const lpSupply = await lpToken0.totalSupply();
            await fund0.mock.getTotalUnderlying.returns(oracle);
            const beforeD = await stableSwap0.getCurrentD();
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

            await fund0.mock.getTotalUnderlying.returns(oracle);
            const beforeToken = await tokens[1].balanceOf(addr2);
            const beforeLP = await lpToken0.balanceOf(addr2);
            await stableSwap0.connect(user2).removeQuoteLiquidity(burnAmount, parseEther("0"));
            const afterToken = await tokens[1].balanceOf(addr2);
            const afterLP = await lpToken0.balanceOf(addr2);
            expect(afterToken.sub(beforeToken)).to.equal(quoteDelta);
            expect(beforeLP.sub(afterLP)).to.equal(burnAmount);
        });
    });
});

describe("Flashloan", function () {
    const REDEMPTION_FEE_BPS = 35;
    const MERGE_FEE_BPS = 45;
    const TOTAL_UNDERLYING = parseBtc("10");
    const EQUIVALENT_TOTAL_M = parseEther("10");
    const SPLIT_RATIO = parseEther("1000");

    interface FixtureWalletMap {
        readonly [name: string]: Wallet;
    }

    interface FixtureData {
        readonly wallets: FixtureWalletMap;
        readonly pancakeRouter: MockContract;
        readonly pancakeSwapRouter: MockContract;
        readonly fund: MockContract;
        readonly primaryMarket: Contract;
        readonly btc: Contract;
        readonly usd: Contract;
        readonly tokens: Contract[];
        readonly swapRouter: Contract;
        readonly flashSwapRouter: Contract;
    }

    const FEE_RATE = parseEther("0.03");
    const ADMIN_FEE_RATE = parseEther("0.4");

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let user1: Wallet;
    let addr1: string;
    let pancakeRouter: MockContract;
    let pancakeSwapRouter: MockContract;
    let fund: MockContract;
    let primaryMarket: Contract;
    let tokens: Contract[];
    let btc: Contract;
    let usd: Contract;
    let swapRouter: Contract;
    let flashSwapRouter: Contract;

    async function deployFixture(_wallets: Wallet[], provider: MockProvider): Promise<FixtureData> {
        const [user1, user2, owner] = provider.getWallets();
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

        const aggregator = await deployMockForName(owner, "AggregatorV3Interface");
        await aggregator.mock.latestRoundData.returns(0, 0, 0, 0, 0);

        const votingEscrow = await deployMockForName(owner, "IVotingEscrow");
        await votingEscrow.mock.getLockedBalance.returns([0, 0]);

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
        await fund.mock.tokenUnderlying.returns(btc.address);
        await fund.mock.underlyingDecimalMultiplier.returns(1e10);
        await fund.mock.isPrimaryMarketActive.returns(true);
        await fund.mock.splitRatio.returns(SPLIT_RATIO);
        await fund.mock.getTotalUnderlying.returns(TOTAL_UNDERLYING);
        await fund.mock.getEquivalentTotalM.returns(EQUIVALENT_TOTAL_M);
        await fund.mock.currentDay.returns(0);
        await fund.mock.getRebalanceSize.returns(0);
        await fund.mock.refreshBalance.returns();
        await fund.mock.extrapolateNav.returns(0, parseEther("1"), parseEther("1"));
        await btc.mint(fund.address, TOTAL_UNDERLYING);
        const PrimaryMarket = await ethers.getContractFactory("PrimaryMarketV3");
        const primaryMarket = await PrimaryMarket.connect(owner).deploy(
            fund.address,
            parseEther("0.0001").mul(REDEMPTION_FEE_BPS),
            parseEther("0.0001").mul(MERGE_FEE_BPS),
            BigNumber.from(1).shl(256).sub(1)
        );

        const chessSchedule = await deployMockForName(owner, "ChessSchedule");
        const chessController = await deployMockForName(owner, "ChessController");
        await chessSchedule.mock.getRate.returns(parseEther("1"));
        await chessController.mock.getFundRelativeWeight.returns(parseEther("1"));

        const pancakeRouter = await deployMockForName(owner, "IPancakeRouter01");

        const SwapRouter = await ethers.getContractFactory("SwapRouter");
        const swapRouter = await SwapRouter.connect(owner).deploy();

        const FlashSwapRouter = await ethers.getContractFactory("FlashSwapRouter");
        const flashSwapRouter = await FlashSwapRouter.connect(owner).deploy(
            pancakeRouter.address,
            swapRouter.address
        );

        const LiquidityGauge = await ethers.getContractFactory("LiquidityGauge");
        const lpToken0 = await LiquidityGauge.connect(owner).deploy(
            "pool2 token",
            "pool2 token",
            chessSchedule.address,
            chessController.address,
            fund.address,
            votingEscrow.address
        );
        const StableSwapRebalance = await ethers.getContractFactory("StableSwapRebalance");
        const stableSwap0 = await StableSwapRebalance.connect(owner).deploy(
            fund.address,
            primaryMarket.address,
            lpToken0.address,
            tokens[0].address,
            usd.address,
            A,
            A,
            owner.address,
            FEE_RATE,
            ADMIN_FEE_RATE,
            aggregator.address,
            parseEther("0.35")
        );

        await swapRouter.addSwap(tokens[0].address, usd.address, stableSwap0.address);
        await lpToken0.transferOwnership(stableSwap0.address);

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
                deadline
            );

        return {
            wallets: { user1, user2, owner },
            pancakeRouter,
            pancakeSwapRouter,
            fund,
            primaryMarket,
            btc,
            usd,
            tokens,
            swapRouter,
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
        flashSwapRouter = fixtureData.flashSwapRouter;
        pancakeRouter = fixtureData.pancakeRouter;
        pancakeSwapRouter = fixtureData.pancakeSwapRouter;
        fund = fixtureData.fund;
        primaryMarket = fixtureData.primaryMarket;
        btc = fixtureData.btc;
        usd = fixtureData.usd;
        tokens = fixtureData.tokens;
    });

    describe("tranchessSwapCallback()", function () {
        it("Should revert if call is not tranchess pair", async function () {
            const stableSwap1 = await deployMockForName(user1, "StableSwapRebalance");
            await stableSwap1.mock.quoteAddress.returns(usd.address);
            await fund.mock.tokenA.returns(tokens[0].address);
            await expect(
                stableSwap1.call(
                    flashSwapRouter,
                    "tranchessSwapCallback",
                    addr1,
                    parseEther("1"),
                    0,
                    defaultAbiCoder.encode(
                        ["address", "uint256", "address", "uint256", "uint256"],
                        [primaryMarket.address, parseEther("1"), addr1, 0, 1]
                    )
                )
            ).to.be.revertedWith("Tranchess Pair check failed");
        });

        it("Should revert if it's bidirectional", async function () {
            const stableSwap1 = await deployMockForName(user1, "StableSwapRebalance");
            await stableSwap1.mock.quoteAddress.returns(usd.address);
            await fund.mock.tokenA.returns(tokens[0].address);
            await swapRouter.addSwap(tokens[0].address, usd.address, stableSwap1.address);
            await expect(
                stableSwap1.call(
                    flashSwapRouter,
                    "tranchessSwapCallback",
                    addr1,
                    parseEther("1"),
                    parseEther("1"),
                    defaultAbiCoder.encode(
                        ["address", "uint256", "address", "uint256", "uint256"],
                        [primaryMarket.address, parseEther("1"), addr1, 0, 1]
                    )
                )
            ).to.be.revertedWith("Unidirectional check failed");
        });
    });

    describe("buyTokenB()", function () {
        it("Should revert if insufficient input quote", async function () {
            const outAB = parseEther("1");
            await fund.mock.tokenUnderlying.returns(btc.address);
            await fund.mock.tokenA.returns(tokens[0].address);
            await pancakeRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await expect(
                flashSwapRouter
                    .connect(user1)
                    .buyTokenB(
                        primaryMarket.address,
                        parseEther("0.03"),
                        addr1,
                        usd.address,
                        1,
                        0,
                        outAB
                    )
            ).to.be.revertedWith("Insufficient input");
        });

        it("Should buy with pancake", async function () {
            const outAB = parseEther("1");
            const createdM = outAB.mul(2).mul(parseEther("1")).div(SPLIT_RATIO);
            await fund.mock.tokenUnderlying.returns(btc.address);
            await fund.mock.tokenA.returns(tokens[0].address);
            await fund.mock.tokenB.returns(tokens[1].address);
            await fund.mock.primaryMarketMint
                .withArgs(0, flashSwapRouter.address, createdM, 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(0, flashSwapRouter.address, createdM, 0)
                .returns();
            await fund.mock.primaryMarketMint
                .withArgs(1, flashSwapRouter.address, outAB, 0)
                .returns();
            await fund.mock.primaryMarketMint
                .withArgs(2, flashSwapRouter.address, outAB, 0)
                .returns();
            await pancakeRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await pancakeRouter.mock.swapExactTokensForTokens.returns([0, parseBtc("0.002")]);

            await btc.mint(flashSwapRouter.address, parseBtc("1"));
            await tokens[0].mint(flashSwapRouter.address, outAB);
            await tokens[1].mint(flashSwapRouter.address, outAB);
            await usd.connect(user1).approve(flashSwapRouter.address, parseEther("1"));

            const beforeQuote = await usd.balanceOf(user1.address);
            const beforeTokenB = await tokens[1].balanceOf(user1.address);

            await flashSwapRouter
                .connect(user1)
                .buyTokenB(primaryMarket.address, parseEther("1"), addr1, usd.address, 1, 0, outAB);

            const afterQuote = await usd.balanceOf(user1.address);
            const afterTokenB = await tokens[1].balanceOf(user1.address);
            expect(afterQuote.sub(beforeQuote)).to.equal(BigNumber.from("-30572571899722170"));
            expect(afterTokenB.sub(beforeTokenB)).to.equal(outAB);
        });
    });

    describe("sellTokenB()", function () {
        it("Should revert if insufficient output quote", async function () {
            const inAB = parseEther("1");
            const quoteAmount = parseEther("2");
            await fund.mock.tokenUnderlying.returns(btc.address);
            await fund.mock.tokenA.returns(tokens[0].address);
            await fund.mock.tokenB.returns(tokens[1].address);
            await fund.mock.primaryMarketBurn
                .withArgs(1, flashSwapRouter.address, inAB, 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(2, flashSwapRouter.address, inAB, 0)
                .returns();
            const mergeAmount = inAB.mul(2).mul(parseEther("1")).div(SPLIT_RATIO);
            const mergeFee = mergeAmount.mul(MERGE_FEE_BPS).div(10000);
            await fund.mock.primaryMarketMint
                .withArgs(0, flashSwapRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await fund.mock.primaryMarketAddDebt
                .withArgs(0, mergeFee.mul(TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_M))
                .returns();
            const redeemAmount = mergeAmount
                .sub(mergeFee)
                .mul(TOTAL_UNDERLYING)
                .div(EQUIVALENT_TOTAL_M);
            const redeemFee = redeemAmount.mul(REDEMPTION_FEE_BPS).div(10000);
            await fund.mock.primaryMarketTransferUnderlying
                .withArgs(flashSwapRouter.address, redeemAmount.sub(redeemFee), redeemFee)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(0, flashSwapRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await pancakeRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await pancakeRouter.mock.swapExactTokensForTokens.returns([0, quoteAmount]);
            await tokens[1].mint(addr1, inAB);
            await tokens[1].connect(user1).approve(flashSwapRouter.address, inAB);
            await usd.mint(flashSwapRouter.address, quoteAmount);

            await expect(
                flashSwapRouter
                    .connect(user1)
                    .sellTokenB(
                        primaryMarket.address,
                        parseEther("1.4"),
                        addr1,
                        usd.address,
                        1,
                        0,
                        inAB
                    )
            ).to.be.revertedWith("Insufficient output");
        });

        it("Should sell with pancake", async function () {
            const inAB = parseEther("1");
            const quoteAmount = parseEther("2");
            await fund.mock.tokenUnderlying.returns(btc.address);
            await fund.mock.tokenA.returns(tokens[0].address);
            await fund.mock.tokenB.returns(tokens[1].address);
            await fund.mock.primaryMarketBurn
                .withArgs(1, flashSwapRouter.address, inAB, 0)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(2, flashSwapRouter.address, inAB, 0)
                .returns();
            const mergeAmount = inAB.mul(2).mul(parseEther("1")).div(SPLIT_RATIO);
            const mergeFee = mergeAmount.mul(MERGE_FEE_BPS).div(10000);
            await fund.mock.primaryMarketMint
                .withArgs(0, flashSwapRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await fund.mock.primaryMarketAddDebt
                .withArgs(0, mergeFee.mul(TOTAL_UNDERLYING).div(EQUIVALENT_TOTAL_M))
                .returns();
            const redeemAmount = mergeAmount
                .sub(mergeFee)
                .mul(TOTAL_UNDERLYING)
                .div(EQUIVALENT_TOTAL_M);
            const redeemFee = redeemAmount.mul(REDEMPTION_FEE_BPS).div(10000);
            await fund.mock.primaryMarketTransferUnderlying
                .withArgs(flashSwapRouter.address, redeemAmount.sub(redeemFee), redeemFee)
                .returns();
            await fund.mock.primaryMarketBurn
                .withArgs(0, flashSwapRouter.address, mergeAmount.sub(mergeFee), 0)
                .returns();
            await pancakeRouter.mock.getAmountsIn.returns([parseEther("1"), 0]);
            await pancakeRouter.mock.swapExactTokensForTokens.returns([0, quoteAmount]);

            await tokens[1].mint(addr1, inAB);
            await tokens[1].connect(user1).approve(flashSwapRouter.address, inAB);
            await usd.mint(flashSwapRouter.address, quoteAmount);

            const beforeQuote = await usd.balanceOf(user1.address);
            const beforeTokenB = await tokens[1].balanceOf(user1.address);

            await flashSwapRouter
                .connect(user1)
                .sellTokenB(primaryMarket.address, parseEther("0"), addr1, usd.address, 1, 0, inAB);

            const afterQuote = await usd.balanceOf(user1.address);
            const afterTokenB = await tokens[1].balanceOf(user1.address);
            expect(afterQuote.sub(beforeQuote)).to.equal(BigNumber.from("968462902096752591"));
            expect(beforeTokenB.sub(afterTokenB)).to.equal(inAB);
        });
    });
});
