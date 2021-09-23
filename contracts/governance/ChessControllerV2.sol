// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../interfaces/IFund.sol";

interface IExchange {
    function fund() external view returns (IFund);
}

contract ChessControllerV2 is CoreUtility, Ownable {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 public immutable guardedLaunchStart;
    mapping(address => uint256) private guardedPoolRatio;

    address[2] private authorizedFunds;
    mapping(address => mapping(uint256 => uint256)) public relativeWeights;

    constructor(
        address[2] memory authorizedFunds_,
        uint256 guardedLaunchStart_,
        uint256 pool0Ratio_,
        uint256 pool1Ratio_
    ) public Ownable() {
        authorizedFunds = authorizedFunds_;
        guardedLaunchStart = guardedLaunchStart_;
        require(pool0Ratio_.add(pool1Ratio_) == 1e18, "invalid ratio");
        guardedPoolRatio[authorizedFunds_[0]] = pool0Ratio_;
        guardedPoolRatio[authorizedFunds_[1]] = pool1Ratio_;
    }

    /// @notice Get Fund relative weight (not more than 1.0) normalized to 1e18
    ///         (e.g. 1.0 == 1e18).
    /// @return relativeWeight Value of relative weight normalized to 1e18
    function getFundRelativeWeight(address fundAddress, uint256 timestamp)
        external
        view
        returns (uint256 relativeWeight)
    {
        if (timestamp < guardedLaunchStart + 4 weeks) {
            return guardedPoolRatio[fundAddress];
        }

        uint256 weekTimestamp = _endOfWeek(timestamp).sub(1 weeks);
        relativeWeight = relativeWeights[fundAddress][weekTimestamp];
        if (relativeWeight != 0) {
            return relativeWeight;
        }

        // Calculate the relative weight if it has not been recorded beforehand
        uint256 fundValueLocked = 0;
        uint256 totalValueLocked = 0;
        for (uint256 i = 0; i < authorizedFunds.length; i++) {
            address authorizedFund = authorizedFunds[i];
            IFund fund = IFund(authorizedFund);

            // If any one of the funds has not been settled yet, return last week's relative weight
            uint256 currentDay = fund.currentDay();
            if (currentDay < weekTimestamp) {
                return relativeWeights[fundAddress][weekTimestamp.sub(1 weeks)];
            }

            // Calculate per-fund TVL
            uint256 price = fund.twapOracle().getTwap(weekTimestamp);
            uint256 valueLocked = fund.historicalUnderlying(weekTimestamp).multiplyDecimal(price);
            totalValueLocked = totalValueLocked.add(valueLocked);
            if (authorizedFund == fundAddress) {
                fundValueLocked = valueLocked;
            }
        }

        relativeWeight = fundValueLocked.divideDecimal(totalValueLocked);
    }

    function updateFundRelativeWeight() public {
        uint256 currentTimestamp = _endOfWeek(block.timestamp) - 1 weeks;

        uint256 totalValueLocked = 0;
        address[2] memory authorizedFunds_ = authorizedFunds;
        uint256[2] memory fundValueLockeds;

        // 1st PASS: get individual and sum of TVLs
        for (uint256 i = 0; i < authorizedFunds_.length; i++) {
            address authorizedFund = authorizedFunds_[i];
            IFund fund = IFund(authorizedFund);

            // If any one of the funds has not been settled yet, skip the update
            uint256 currentDay = fund.currentDay();
            require(currentDay >= currentTimestamp, "Fund not been settled yet");

            // Calculate per-fund TVL
            uint256 price = fund.twapOracle().getTwap(currentTimestamp);
            uint256 valueLocked =
                fund.historicalUnderlying(currentTimestamp).multiplyDecimal(price);
            fundValueLockeds[i] = valueLocked;
            totalValueLocked = totalValueLocked.add(valueLocked);
        }

        // 2nd PASS: calculate the relative weights of each fund
        for (uint256 i = 0; i < authorizedFunds_.length; i++) {
            address authorizedFund = authorizedFunds_[i];
            if (relativeWeights[authorizedFund][currentTimestamp] == 0) {
                relativeWeights[authorizedFund][currentTimestamp] = fundValueLockeds[i]
                    .divideDecimal(totalValueLocked);
            }
        }
    }

    function updateGuardedLaunchRatio(uint256 pool0Ratio, uint256 pool1Ratio) external onlyOwner {
        require(pool0Ratio.add(pool1Ratio) == 1e18, "Invalid ratio");
        guardedPoolRatio[authorizedFunds[0]] = pool0Ratio;
        guardedPoolRatio[authorizedFunds[1]] = pool1Ratio;
    }
}
