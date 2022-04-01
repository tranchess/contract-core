// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../../utils/CoreUtility.sol";
import "../../utils/SafeDecimalMath.sol";
import "../../interfaces/IChessController.sol";
import "../interfaces/IFund.sol";
import "../../interfaces/IControllerBallot.sol";

contract ChessControllerV4 is IChessController, CoreUtility {
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[192] private _reservedSlots;

    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    event WeightUpdated(address indexed fund, uint256 indexed timestamp, uint256 weight);

    address public immutable fund0;
    uint256 public immutable guardedLaunchStart;
    address public immutable controllerBallot;

    mapping(uint256 => mapping(address => uint256)) public weights;

    /// @notice Start timestamp of the last trading week that has weights updated.
    uint256 public lastTimestamp;

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

    /// @dev Initialize the part added in V4. The contract is designed to be used with OpenZeppelin's
    ///      `TransparentUpgradeableProxy`. If this contract is upgraded from the previous version,
    ///      call `upgradeToAndCall` of the proxy and put a call to this function in the `data`
    ///      argument with `lastTimestamp_` set to the last updated week. If this contract is
    ///      the first implementation of the proxy, This function should be called by the proxy's
    ///      constructor (via the `_data` argument) with `lastTimestamp_` set to one week before
    ///      `guardedLaunchStart`.
    function initializeV4(uint256 lastTimestamp_) external {
        require(lastTimestamp == 0, "Already initialized");
        require(
            _endOfWeek(lastTimestamp_) == lastTimestamp_ + 1 weeks &&
                lastTimestamp_ >= guardedLaunchStart - 1 weeks
        );
        require(weights[lastTimestamp_ + 1 weeks][fund0] == 0, "Next week already updated");
        if (lastTimestamp_ >= guardedLaunchStart) {
            require(weights[lastTimestamp_][fund0] > 0, "Last week not updated");
        }
        lastTimestamp = lastTimestamp_;
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
        uint256 lastTimestamp_ = lastTimestamp; // gas saver
        require(weekTimestamp <= lastTimestamp_ + 1 weeks, "Previous week is empty");
        if (weekTimestamp <= lastTimestamp_) {
            return weights[weekTimestamp][fundAddress];
        }
        lastTimestamp = lastTimestamp_ + 1 weeks;
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
            emit WeightUpdated(funds[i], weekTimestamp, fundWeight);
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
