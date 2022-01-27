// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IFund.sol";
import "../interfaces/IControllerBallot.sol";

contract ChessControllerV3 is IChessController, CoreUtility {
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[192] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    address public immutable fund0;
    uint256 public immutable guardedLaunchStart;
    address public immutable controllerBallot;

    mapping(uint256 => mapping(address => uint256)) public weights;

    constructor(
        address fund0_,
        uint256 guardedLaunchStart_,
        address controllerBallot_
    ) public {
        fund0 = fund0_;
        guardedLaunchStart = guardedLaunchStart_;
        require(_endOfWeek(guardedLaunchStart_) == guardedLaunchStart_ + 1 weeks);
        controllerBallot = controllerBallot_;
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
        if (timestamp < guardedLaunchStart) {
            return fundAddress == fund0 ? 1e18 : 0;
        }

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
        (uint256[] memory ballotWeights, address[] memory funds) =
            IControllerBallot(controllerBallot).count(weekTimestamp);

        uint256 totalValueLocked;
        uint256[] memory fundValueLocked = new uint256[](ballotWeights.length);
        for (uint256 i = 0; i < ballotWeights.length; i++) {
            fundValueLocked[i] = getFundValueLocked(funds[i], weekTimestamp);
            totalValueLocked = totalValueLocked.add(fundValueLocked[i]);
        }

        uint256 totalWeight;
        for (uint256 i = 0; i < ballotWeights.length; i++) {
            uint256 fundWeight = ballotWeights[i];
            if (totalValueLocked > 0) {
                fundWeight = fundWeight.add(fundValueLocked[i].divideDecimal(totalValueLocked)) / 2;
            }
            weights[weekTimestamp][funds[i]] = fundWeight;
            if (funds[i] == fundAddress) {
                weight = fundWeight;
            }
            totalWeight = totalWeight.add(fundWeight);
        }
        require(totalWeight <= 1e18, "Total weight exceeds 100%");
    }

    function getFundValueLocked(address fund, uint256 weekTimestamp) public view returns (uint256) {
        uint256 timestamp = (IFund(fund).currentDay() - 1 days).min(weekTimestamp);
        (uint256 navM, , ) = IFund(fund).historicalNavs(timestamp);
        return IFund(fund).historicalTotalShares(timestamp).multiplyDecimal(navM);
    }
}
