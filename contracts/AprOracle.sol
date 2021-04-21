// SPDX-License-Identifier: MIT
pragma solidity 0.6.9;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/IAprOracle.sol";
import "./utils/SafeDecimalMath.sol";
import "./utils/Exponential.sol";

// Compound
interface CTokenInterface {
    function borrowIndex() external view returns (uint256);

    function borrowRatePerBlock() external view returns (uint256);

    function accrualBlockNumber() external view returns (uint256);
}

// Aave
interface ILendingPool {
    function getReserveNormalizedVariableDebt(address asset) external view returns (uint256);
}

contract AprOracle is IAprOracle, Exponential {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 public constant DECIMAL = 10**18;
    uint256 public constant COMPOUND_BORROW_MAX_MANTISSA = 0.0005e16;

    // Mainnet: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
    // Kovan: 0xe22da380ee6B445bb8273C81944ADEB6E8450422
    address public immutable usdc;

    // Kovan: 0x9FE532197ad76c5a68961439604C037EB79681F0
    address public immutable aaveUsdcLendingPool;

    // Mainnet: 0x39AA39c021dfbaE8faC545936693aC917d5E7563
    // Kovan: 0x4a92E71227D294F041BD82dd8f78591B75140d63
    address public immutable cUsdc;

    string public name;
    uint256 public compoundBorrowIndex;
    uint256 public aaveBorrowIndex;
    uint256 public timestamp;

    address public fund;

    constructor(
        string memory _name,
        address _fund,
        address _usdc,
        address _aaveUsdcLendingPool,
        address _cUsdc
    ) public {
        name = _name;
        fund = _fund;
        usdc = _usdc;
        aaveUsdcLendingPool = _aaveUsdcLendingPool;
        cUsdc = _cUsdc;
        compoundBorrowIndex = getCompoundBorrowIndex(_cUsdc);
        aaveBorrowIndex = getAaveBorrowIndex(_aaveUsdcLendingPool, _usdc);
        timestamp = block.timestamp;
    }

    // Compound
    function getCompoundBorrowIndex(address cToken) public view returns (uint256 newBorrowIndex) {
        /* Calculate the current borrow interest rate */
        uint256 borrowRateMantissa = CTokenInterface(cToken).borrowRatePerBlock();
        require(borrowRateMantissa <= COMPOUND_BORROW_MAX_MANTISSA, "borrow rate is absurdly high");

        uint256 borrowIndexPrior = CTokenInterface(cToken).borrowIndex();
        uint256 accrualBlockNumber = CTokenInterface(cToken).accrualBlockNumber();

        (, uint256 blockDelta) = subUInt(block.number, accrualBlockNumber);

        (, Exp memory simpleInterestFactor) =
            mulScalar(Exp({mantissa: borrowRateMantissa}), blockDelta);
        (, newBorrowIndex) = mulScalarTruncateAddUInt(
            simpleInterestFactor,
            borrowIndexPrior,
            borrowIndexPrior
        );
    }

    // Aave
    function getAaveBorrowIndex(address aaveLendingPool, address token)
        public
        view
        returns (uint256 newBorrowRate)
    {
        newBorrowRate = ILendingPool(aaveLendingPool).getReserveNormalizedVariableDebt(token);
    }

    function getAverageDailyRate()
        public
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        uint256 newCompoundBorrowIndex = getCompoundBorrowIndex(cUsdc);
        uint256 newAaveBorrowRate = getAaveBorrowIndex(aaveUsdcLendingPool, usdc);

        uint256 compoundPeriodicRate =
            newCompoundBorrowIndex.sub(compoundBorrowIndex).divideDecimal(compoundBorrowIndex);
        uint256 aavePeriodicRate =
            newAaveBorrowRate.sub(aaveBorrowIndex).divideDecimal(aaveBorrowIndex);

        uint256 dailyRate =
            compoundPeriodicRate.add(aavePeriodicRate).mul(1 days).div(2).div(
                block.timestamp.sub(timestamp)
            );

        return (
            newCompoundBorrowIndex,
            newAaveBorrowRate,
            compoundPeriodicRate,
            aavePeriodicRate,
            dailyRate
        );
    }

    function capture() public override returns (uint256 dailyRate) {
        require(msg.sender == fund, "only fund");
        (compoundBorrowIndex, aaveBorrowIndex, , , dailyRate) = getAverageDailyRate();
        timestamp = block.timestamp;
    }
}
