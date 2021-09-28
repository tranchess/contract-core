// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IFund.sol";

interface IExchange {
    function fund() external view returns (IFund);
}

contract ChessControllerV2 is IChessController, CoreUtility {
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[32] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 public constant WINDOW_SIZE = 4;
    uint256 public immutable minRatio;

    bool public initialized;

    address public immutable fund0;
    address public immutable fund1;
    mapping(address => mapping(uint256 => uint256)) public relativeWeights;

    uint256 public immutable guardedLaunchStart;
    uint256 public guardedLaunchDuration;

    constructor(
        address fund0_,
        address fund1_,
        uint256 guardedLaunchStart_,
        uint256 minRatio_
    ) public {
        fund0 = fund0_;
        fund1 = fund1_;
        guardedLaunchStart = guardedLaunchStart_;
        minRatio = minRatio_;
    }

    function initialize(uint256[] memory weeklyPoolRatios0_) public {
        require(!initialized, "Already Initialized");
        require(_endOfWeek(guardedLaunchStart) == guardedLaunchStart + 1 weeks, "Not end of week");
        guardedLaunchDuration = weeklyPoolRatios0_.length * 1 weeks;
        for (uint256 i = 0; i < weeklyPoolRatios0_.length; i++) {
            relativeWeights[fund0][guardedLaunchStart + i * 1 weeks] = weeklyPoolRatios0_[i];
            relativeWeights[fund1][guardedLaunchStart + i * 1 weeks] = uint256(1e18).sub(
                weeklyPoolRatios0_[i]
            );
        }
        initialized = true;
    }

    /// @notice Get Fund relative weight (not more than 1.0) normalized to 1e18
    ///         (e.g. 1.0 == 1e18).
    /// @return relativeWeight Value of relative weight normalized to 1e18
    function getFundRelativeWeight(address fundAddress, uint256 timestamp)
        external
        override
        returns (uint256 relativeWeight)
    {
        if (timestamp < guardedLaunchStart) {
            if (fundAddress == fund0) {
                return 1e18;
            } else {
                return 0;
            }
        }

        uint256 weekTimestamp = _endOfWeek(timestamp).sub(1 weeks);
        if (timestamp < guardedLaunchStart + guardedLaunchDuration) {
            return relativeWeights[fundAddress][weekTimestamp];
        }

        (uint256 relativeWeight0, uint256 relativeWeight1) = updateFundRelativeWeight();
        if (fundAddress == fund0) {
            relativeWeight = relativeWeight0;
        } else {
            relativeWeight = relativeWeight1;
        }
    }

    function updateFundRelativeWeight()
        public
        returns (uint256 relativeWeightMovingAverage0, uint256 relativeWeightMovingAverage1)
    {
        uint256 currentTimestamp = _endOfWeek(block.timestamp) - 1 weeks;

        // 1st PASS: get individual and sum of TVLs. Avoids 0 TVLs
        uint256 fundValueLocked0 = getFundTVL(fund0);
        uint256 fundValueLocked1 = getFundTVL(fund1);
        uint256 totalValueLocked = fundValueLocked0.add(fundValueLocked1);

        // 2nd PASS: calculate the relative weights of each fund
        if (totalValueLocked == 0) {
            relativeWeightMovingAverage0 = relativeWeights[fund0][currentTimestamp - 1 weeks];
            relativeWeightMovingAverage1 = relativeWeights[fund1][currentTimestamp - 1 weeks];
        } else {
            uint256 latestRelativeWeight0 = fundValueLocked0.divideDecimal(totalValueLocked);
            relativeWeightMovingAverage0 = _getMovingAverage(
                fund0,
                currentTimestamp,
                latestRelativeWeight0
            );
            relativeWeightMovingAverage1 = uint256(1e18).sub(relativeWeightMovingAverage0);
        }
        if (
            relativeWeights[fund0][currentTimestamp] == 0 &&
            relativeWeights[fund1][currentTimestamp] == 0
        ) {
            relativeWeights[fund0][currentTimestamp] = relativeWeightMovingAverage0;
            relativeWeights[fund1][currentTimestamp] = relativeWeightMovingAverage1;
        }
    }

    function getFundTVL(address fund) public view returns (uint256 fundValueLocked) {
        uint256 currentDay = IFund(fund).currentDay();
        uint256 price = IFund(fund).twapOracle().getTwap(currentDay - 1 days);
        fundValueLocked = IFund(fund).historicalUnderlying(currentDay - 1 days).multiplyDecimal(
            price
        );
    }

    /// @dev Ratio of week T is 25% of the latest ratio plus 75% of ratio from last week
    function _getMovingAverage(
        address fundAddress,
        uint256 weekTimestamp,
        uint256 latestRelativeWeight
    ) private view returns (uint256 movingAverage) {
        movingAverage =
            relativeWeights[fundAddress][weekTimestamp - 1 weeks].mul(3) +
            latestRelativeWeight;
        movingAverage = (movingAverage / WINDOW_SIZE).max(minRatio).min(1e18 - minRatio);
    }
}
