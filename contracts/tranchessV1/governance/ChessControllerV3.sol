// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../../utils/CoreUtility.sol";
import "../../utils/SafeDecimalMath.sol";
import "../../interfaces/IChessController.sol";
import "../interfaces/IFund.sol";

contract ChessControllerV3 is IChessController, CoreUtility {
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[192] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 public constant WINDOW_SIZE = 2;
    uint256 public immutable minWeight;

    address public immutable fund0;
    address public immutable fund1;
    address public immutable fund2;

    uint256 public immutable guardedLaunchStart;
    uint256 public immutable guardedLaunchStartV3;

    mapping(uint256 => mapping(address => uint256)) public weights;

    constructor(
        address fund0_,
        address fund1_,
        address fund2_,
        uint256 guardedLaunchStart_,
        uint256 guardedLaunchStartV3_,
        uint256 minWeight_
    ) public {
        require(minWeight_ > 0 && minWeight_ < 0.5e18);
        fund0 = fund0_;
        fund1 = fund1_;
        fund2 = fund2_;
        guardedLaunchStart = guardedLaunchStart_;
        require(_endOfWeek(guardedLaunchStart_) == guardedLaunchStart_ + 1 weeks);
        guardedLaunchStartV3 = guardedLaunchStartV3_;
        require(_endOfWeek(guardedLaunchStartV3_) == guardedLaunchStartV3_ + 1 weeks);
        require(guardedLaunchStartV3_ > guardedLaunchStart_);
        minWeight = minWeight_;
    }

    function initializeV3(uint256[] calldata guardedWeights2_) external {
        require(guardedLaunchStartV3 > block.timestamp, "Too late to initialize");
        // Make sure guarded launch in V2 has been initialized.
        require(weights[guardedLaunchStart][fund0] != 0);
        // Make sure guarded launch in V2 has ended.
        require(weights[guardedLaunchStartV3][fund0] == 0);
        require(weights[guardedLaunchStartV3][fund2] == 0, "Already initialized");
        require(guardedWeights2_.length > 0);
        for (uint256 i = 0; i < guardedWeights2_.length; i++) {
            uint256 weight2 = guardedWeights2_[i];
            require(weight2 >= minWeight && weight2 <= 1e18 - minWeight * 2, "Invalid weight");
            weights[guardedLaunchStartV3 + i * 1 weeks][fund2] = weight2;
        }
    }

    /// @notice Get Fund relative weight (not more than 1.0) normalized to 1e18
    ///         (e.g. 1.0 == 1e18).
    /// @return weight Value of relative weight normalized to 1e18
    function getFundRelativeWeight(address fundAddress, uint256 timestamp)
        external
        override
        returns (uint256)
    {
        require(timestamp <= block.timestamp, "Too soon");
        if (fundAddress != fund0 && fundAddress != fund1 && fundAddress != fund2) {
            return 0;
        }
        if (timestamp < guardedLaunchStart) {
            return fundAddress == fund0 ? 1e18 : 0;
        } else if (timestamp < guardedLaunchStartV3 && fundAddress == fund2) {
            return 0;
        }

        uint256 weekTimestamp = _endOfWeek(timestamp).sub(1 weeks);
        uint256 weight = weights[weekTimestamp][fundAddress];
        if (weight != 0) {
            return weight;
        }

        (uint256 weight0, uint256 weight1, uint256 weight2) = _updateFundWeight(weekTimestamp);
        if (fundAddress == fund0) {
            return weight0;
        } else if (fundAddress == fund1) {
            return weight1;
        } else {
            return weight2;
        }
    }

    function _updateFundWeight(uint256 weekTimestamp)
        private
        returns (
            uint256 weight0,
            uint256 weight1,
            uint256 weight2
        )
    {
        uint256 prevWeight0 = weights[weekTimestamp - 1 weeks][fund0];
        require(prevWeight0 != 0, "Previous week is empty");
        uint256 prevWeight2 = weights[weekTimestamp - 1 weeks][fund2];
        weight2 = weights[weekTimestamp][fund2];
        if (weight2 == 0) {
            // After guarded launch V3, keep weight of fund 2 constant. This contract is planned to
            // be upgraded again after guarded launch V3 and the constant weight2 won't last long.
            weight2 = prevWeight2;
        }
        prevWeight0 = prevWeight0.mul(1e18 - weight2).div(1e18 - prevWeight2).max(minWeight).min(
            1e18 - weight2 - minWeight
        );
        uint256 fundValueLocked0 = getFundValueLocked(fund0, weekTimestamp);
        uint256 totalValueLocked = fundValueLocked0.add(getFundValueLocked(fund1, weekTimestamp));

        if (totalValueLocked == 0) {
            weight0 = prevWeight0;
        } else {
            weight0 = (prevWeight0.mul(WINDOW_SIZE - 1).add(
                fundValueLocked0.mul(1e18 - weight2).div(totalValueLocked)
            ) / WINDOW_SIZE)
                .max(minWeight)
                .min(1e18 - weight2 - minWeight);
        }
        weight1 = 1e18 - weight2 - weight0;

        weights[weekTimestamp][fund0] = weight0;
        weights[weekTimestamp][fund1] = weight1;
        weights[weekTimestamp][fund2] = weight2;
    }

    function getFundValueLocked(address fund, uint256 weekTimestamp)
        public
        view
        returns (uint256 fundValueLocked)
    {
        uint256 timestamp = (IFund(fund).currentDay() - 1 days).min(weekTimestamp);
        (uint256 navM, , ) = IFund(fund).historicalNavs(timestamp);
        fundValueLocked = IFund(fund).historicalTotalShares(timestamp).multiplyDecimal(navM);
    }
}
