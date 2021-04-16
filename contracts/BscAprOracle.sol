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

    // Mainnet: 0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8
    // Testnet: 0xD5C4C2e2facBEB59D0216D0595d63FcDc6F9A1a7
    address public VTOKEN = address(0xD5C4C2e2facBEB59D0216D0595d63FcDc6F9A1a7);

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
        uint256 borrowRateMantissa = VTokenInterfaces(VTOKEN).borrowRatePerBlock();
        require(borrowRateMantissa <= VENUS_BORROW_MAX_MANTISSA, "borrow rate is absurdly high");

        uint256 borrowIndexPrior = VTokenInterfaces(VTOKEN).borrowIndex();
        uint256 accrualBlockNumber = VTokenInterfaces(VTOKEN).accrualBlockNumber();

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

        uint256 dailyRate = venusPeriodicRate.mul(1 days).div(block.timestamp.sub(timestamp));

        return (newvenusBorrowIndex, venusPeriodicRate, dailyRate);
    }

    function capture() public override returns (uint256 dailyRate) {
        require(msg.sender == fund, "only fund");
        (venusBorrowIndex, , dailyRate) = getAverageDailyRate();
    }
}
