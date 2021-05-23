// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../interfaces/IAprOracle.sol";
import "../utils/SafeDecimalMath.sol";
import "../utils/Exponential.sol";
import "../utils/CoreUtility.sol";

// Venus
interface VTokenInterfaces {
    function borrowIndex() external view returns (uint256);

    function borrowRatePerBlock() external view returns (uint256);

    function accrualBlockNumber() external view returns (uint256);
}

contract BscAprOracle is IAprOracle, Exponential, CoreUtility {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 public constant VENUS_BORROW_MAX_MANTISSA = 0.0005e16;

    address public immutable vUsdc;

    string public name;
    uint256 public venusBorrowIndex;
    uint256 public timestamp;
    uint256 public currentDailyRate;

    constructor(string memory name_, address vUsdc_) public {
        name = name_;
        vUsdc = vUsdc_;
        venusBorrowIndex = getVenusBorrowIndex(vUsdc_);
        timestamp = block.timestamp;
    }

    // Venus
    function getVenusBorrowIndex(address vToken) public view returns (uint256 newBorrowIndex) {
        /* Calculate the current borrow interest rate */
        uint256 borrowRateMantissa = VTokenInterfaces(vToken).borrowRatePerBlock();
        require(borrowRateMantissa <= VENUS_BORROW_MAX_MANTISSA, "Borrow rate is absurdly high");

        uint256 borrowIndexPrior = VTokenInterfaces(vToken).borrowIndex();
        uint256 accrualBlockNumber = VTokenInterfaces(vToken).accrualBlockNumber();

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
        uint256 newVenusBorrowIndex = getVenusBorrowIndex(vUsdc);

        uint256 venusPeriodicRate =
            newVenusBorrowIndex.sub(venusBorrowIndex).divideDecimal(venusBorrowIndex);

        uint256 dailyRate = venusPeriodicRate.mul(1 days).div(block.timestamp.sub(timestamp));

        return (newVenusBorrowIndex, venusPeriodicRate, dailyRate);
    }

    function capture() external override returns (uint256 dailyRate) {
        uint256 currentWeek = _endOfWeek(timestamp);
        if (currentWeek > block.timestamp) {
            return currentDailyRate;
        }

        (venusBorrowIndex, , dailyRate) = getAverageDailyRate();
        timestamp = block.timestamp;
        currentDailyRate = dailyRate;
    }
}
