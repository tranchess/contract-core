import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import type { Fixture } from "ethereum-waffle";
import { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;

describe("AdvancedMath", function () {
    interface FixtureData {
        readonly advancedMathWrapper: Contract;
    }

    let currentFixture: Fixture<FixtureData>;
    let fixtureData: FixtureData;

    let advancedMathWrapper: Contract;

    async function deployFixture(): Promise<FixtureData> {
        const AdvancedMathWrapper = await ethers.getContractFactory("AdvancedMathWrapper");
        const advancedMathWrapper = await AdvancedMathWrapper.deploy();

        return {
            advancedMathWrapper: advancedMathWrapper,
        };
    }

    before(function () {
        currentFixture = deployFixture;
    });

    beforeEach(async function () {
        fixtureData = await loadFixture(currentFixture);
        advancedMathWrapper = fixtureData.advancedMathWrapper;
    });

    describe("sqrt()", function () {
        it("Should find the square root of a small number", async function () {
            expect(await advancedMathWrapper.sqrt(0)).to.equal(0);
            expect(await advancedMathWrapper.sqrt(1)).to.equal(1);
            expect(await advancedMathWrapper.sqrt(4)).to.equal(2);
        });

        it("Should find the square root of a big number", async function () {
            expect(
                await advancedMathWrapper.sqrt(
                    BigNumber.from(
                        "55186156870478567193644641351382124067713781048612400765092754877653207859685"
                    )
                )
            ).to.equal(BigNumber.from("234917340506141792124551400965823811665"));
        });
    });

    describe("cbrt()", function () {
        it("Should find the cube root of a small number", async function () {
            expect(await advancedMathWrapper.cbrt(0)).to.equal(0);
            expect(await advancedMathWrapper.cbrt(1)).to.equal(1);
            expect(await advancedMathWrapper.cbrt(8)).to.equal(2);
        });

        it("Should find the cube root of a big number", async function () {
            expect(
                await advancedMathWrapper.cbrt(
                    BigNumber.from(
                        "55186156870478567193644641351382124067713781048612400765092754877653207859685"
                    )
                )
            ).to.equal(BigNumber.from("38072382092838690183991666"));
        });
    });
});
