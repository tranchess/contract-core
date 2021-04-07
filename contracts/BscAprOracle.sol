// SPDX-License-Identifier: MIT
pragma solidity 0.6.9;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "./interfaces/IAprOracle.sol";
import "./utils/SafeDecimalMath.sol";
import "./utils/Exponential.sol";

// Venus
interface VTokenInterfaces {
    function borrowIndex() external view returns (uint256);

    function borrowRatePerBlock() external view returns (uint256);

    function accrualBlockNumber() external view returns (uint256);
}

contract BscAprOracle is IAprOracle, Exponential {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 public constant VENUS_BORROW_MAX_MANTISSA = 0.0005e16;

    string public name;

    // Mainnet: 0x39AA39c021dfbaE8faC545936693aC917d5E7563
    // Kovan: 0x4a92E71227D294F041BD82dd8f78591B75140d63
    address public CTOKEN = address(0x4a92E71227D294F041BD82dd8f78591B75140d63);

    uint256 public venusBorrowIndex;
    uint256 public timestamp;

    address public fund;

    constructor(string memory _name, address _fund) public {
        name = _name;
        venusBorrowIndex = getVenusBorrowIndex();
        timestamp = block.timestamp;
        fund = _fund;
    }

    // Venus
    function getVenusBorrowIndex() public view returns (uint256 newBorrowIndex) {
        /* Calculate the current borrow interest rate */
        uint256 borrowRateMantissa = VTokenInterfaces(CTOKEN).borrowRatePerBlock();
        require(borrowRateMantissa <= VENUS_BORROW_MAX_MANTISSA, "borrow rate is absurdly high");

        uint256 borrowIndexPrior = VTokenInterfaces(CTOKEN).borrowIndex();
        uint256 accrualBlockNumber = VTokenInterfaces(CTOKEN).accrualBlockNumber();

        (, uint256 blockDelta) = subUInt(block.number, accrualBlockNumber);

        (, Exp memory simpleInterestFactor) =
            mulScalar(Exp({mantissa: borrowRateMantissa}), blockDelta);
        (, newBorrowIndex) = mulScalarTruncateAddUInt(
            simpleInterestFactor,
            borrowIndexPrior,
            borrowIndexPrior
        );
    }

    function getAverageDailyRate()
        public
        view
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        uint256 newvenusBorrowIndex = getVenusBorrowIndex();

        uint256 venusPeriodicRate =
            newvenusBorrowIndex.sub(venusBorrowIndex).divideDecimal(venusBorrowIndex);

        uint256 dailyRate = venusPeriodicRate.mul(0.5 days).div(block.timestamp.sub(timestamp));

        return (newvenusBorrowIndex, venusPeriodicRate, dailyRate);
    }

    function capture() public override returns (uint256 dailyRate) {
        require(msg.sender == fund, "only fund");
        (venusBorrowIndex, , dailyRate) = getAverageDailyRate();
    }
}
