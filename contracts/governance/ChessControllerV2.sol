// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../interfaces/IFund.sol";

interface IExtendedFund is IFund {
    function historicalUnderlying(uint256 timestamp) external view returns (uint256);
}

contract ChessControllerV2 is CoreUtility, Ownable {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    address[2] private authorizedFunds;

    mapping(address => mapping(uint256 => uint256)) relativeWeights;

    constructor(address[2] memory authorizedFunds_) public {
        authorizedFunds = authorizedFunds_;
    }

    /// @notice Get Fund relative weight (not more than 1.0) normalized to 1e18
    ///         (e.g. 1.0 == 1e18).
    /// @return relativeWeight Value of relative weight normalized to 1e18
    function getFundRelativeWeight(address contractAddress, uint256 timestamp)
        external
        view
        returns (uint256 relativeWeight)
    {
        relativeWeight = relativeWeights[contractAddress][timestamp];
        if (relativeWeight != 0) {
            return relativeWeight;
        }

        // Calculate the relative weight if it has not been recorded beforehand
        uint256 currentTimestamp = _endOfWeek(block.timestamp);
        uint256 fundValueLocked = 0;
        uint256 totalValueLocked = 0;
        for (uint256 i = 0; i < authorizedFunds.length; i++) {
            address fundAddress = authorizedFunds[i];
            IExtendedFund fund = IExtendedFund(fundAddress);

            // If any one of the funds has not been settled yet, return last week's relative weight
            uint256 currentDay = fund.currentDay();
            if (currentDay >= currentTimestamp) {
                return relativeWeights[contractAddress][currentTimestamp - 1 weeks];
            }

            // Calculate per-fund TVL
            uint256 price = fund.twapOracle().getTwap(timestamp);
            uint256 valueLocked = fund.historicalUnderlying(timestamp).multiplyDecimal(price);
            totalValueLocked = totalValueLocked.add(valueLocked);
            if (fundAddress == contractAddress) {
                fundValueLocked = valueLocked;
            }
        }

        relativeWeight = fundValueLocked.divideDecimal(totalValueLocked);
    }

    function updateFundRelativeWeight() public {
        uint256 currentTimestamp = _endOfWeek(block.timestamp);

        uint256 totalValueLocked = 0;
        address[2] memory authorizedFunds_ = authorizedFunds;
        uint256[2] memory fundValueLockeds;

        // 1st PASS: get individual and sum of TVLs
        for (uint256 i = 0; i < authorizedFunds_.length; i++) {
            address fundAddress = authorizedFunds_[i];
            IExtendedFund fund = IExtendedFund(fundAddress);

            // If any one of the funds has not been settled yet, skip the update
            uint256 currentDay = fund.currentDay();
            require(currentDay < currentTimestamp, "Fund not been settled yet");

            // Calculate per-fund TVL
            uint256 price = fund.twapOracle().getTwap(currentTimestamp);
            uint256 valueLocked =
                fund.historicalUnderlying(currentTimestamp).multiplyDecimal(price);
            fundValueLockeds[i] = valueLocked;
            totalValueLocked = totalValueLocked.add(valueLocked);
        }

        // 2nd PASS: calculate the relative weights of each fund
        for (uint256 i = 0; i < authorizedFunds_.length; i++) {
            address fundAddress = authorizedFunds_[i];
            if (relativeWeights[fundAddress][currentTimestamp] == 0) {
                relativeWeights[fundAddress][currentTimestamp] = fundValueLockeds[i].divideDecimal(
                    totalValueLocked
                );
            }
        }
    }
}
