// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IFund.sol";
import "../interfaces/IFundBallot.sol";

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

    address public immutable fundBallot;

    constructor(
        address fund0_,
        address fund1_,
        address fund2_,
        uint256 guardedLaunchStart_,
        uint256 guardedLaunchStartV3_,
        uint256 minWeight_,
        address fundBallot_
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
        fundBallot = fundBallot_;
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
        uint256 weekTimestamp = _endOfWeek(timestamp).sub(1 weeks);
        uint256 weight = weights[weekTimestamp][fundAddress];
        if (weight != 0) {
            return weight;
        }

        return _updateFundWeight(weekTimestamp, fundAddress);
    }

    function _updateFundWeight(uint256 weekTimestamp, address fundAddress)
        private
        returns (uint256 weight)
    {
        (uint256[] memory ratios, address[] memory funds) =
            IFundBallot(fundBallot).count(weekTimestamp);

        uint256 totalValueLocked;
        for (uint256 i = 0; i < ratios.length; i++) {
            uint256 fundValueLocked = getFundValueLocked(funds[i], weekTimestamp);
            totalValueLocked = totalValueLocked.add(fundValueLocked);
        }

        for (uint256 i = 0; i < ratios.length; i++) {
            uint256 fundValueLocked = getFundValueLocked(funds[i], weekTimestamp);

            uint256 fundWeight = ratios[i];
            if (totalValueLocked > 0) {
                fundWeight = fundWeight.add(fundValueLocked.divideDecimal(totalValueLocked)) / 2;
            }

            weights[weekTimestamp][funds[i]] = fundWeight;
            if (funds[i] == fundAddress) {
                weight = fundWeight;
            }
        }
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
