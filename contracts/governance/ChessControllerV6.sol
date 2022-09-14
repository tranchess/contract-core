// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../interfaces/IChessController.sol";
import "../interfaces/IControllerBallotV2.sol";

interface IChessScheduleRelayer {
    function veSupplyPerWeek(uint256 week) external view returns (uint256);
}

contract ChessControllerV6 is IChessController, CoreUtility {
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[192] private _reservedSlots;

    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    event WeightUpdated(address indexed fund, uint256 indexed timestamp, uint256 weight);
    event ScheduleRelayerAdded(address scheduleRelayer);
    event ScheduleRelayerRemoved(address scheduleRelayer);

    address public immutable fund0;
    uint256 public immutable guardedLaunchStart;
    IControllerBallotV2 public immutable controllerBallot;

    mapping(uint256 => mapping(address => uint256)) public weights;

    /// @notice Start timestamp of the last trading week that has weights updated.
    uint256 public lastTimestamp;

    EnumerableSet.AddressSet private _scheduleRelayers;

    constructor(
        address fund0_,
        uint256 guardedLaunchStart_,
        address controllerBallot_
    ) public {
        fund0 = fund0_;
        guardedLaunchStart = guardedLaunchStart_;
        require(_endOfWeek(guardedLaunchStart_) == guardedLaunchStart_ + 1 weeks);
        controllerBallot = IControllerBallotV2(controllerBallot_);
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

    function owner() public view returns (address) {
        // Use the ballot's owner as this contract's owner.
        return Ownable(address(controllerBallot)).owner();
    }

    modifier onlyOwner() {
        require(owner() == msg.sender, "Ownable: caller is not the owner");
        _;
    }

    function getScheduleRelayers() public view returns (address[] memory relayers) {
        uint256 length = _scheduleRelayers.length();
        relayers = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            relayers[i] = _scheduleRelayers.at(i);
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
        return _updateWeight(weekTimestamp, fundAddress);
    }

    function _updateWeight(uint256 weekTimestamp, address pool) private returns (uint256 weight) {
        uint256 total = 0;
        (uint256[] memory sums, address[] memory pools) = controllerBallot.count(weekTimestamp);
        for (uint256 i = 0; i < pools.length; i++) {
            total = total.add(sums[i]);
        }
        address[] memory relayers = getScheduleRelayers();
        uint256[] memory relayerSupplies = new uint256[](relayers.length);
        for (uint256 i = 0; i < relayers.length; i++) {
            uint256 relayerSupply =
                IChessScheduleRelayer(relayers[i]).veSupplyPerWeek(weekTimestamp);
            relayerSupplies[i] = relayerSupply;
            total = total.add(relayerSupply);
        }

        for (uint256 i = 0; i < pools.length; i++) {
            uint256 w =
                total != 0 ? sums[i].divideDecimal(total) : 1e18 / (pools.length + relayers.length);
            weights[weekTimestamp][pools[i]] = w;
            emit WeightUpdated(pools[i], weekTimestamp, w);
            if (pools[i] == pool) {
                weight = w;
            }
        }
        for (uint256 i = 0; i < relayers.length; i++) {
            uint256 w =
                total != 0
                    ? relayerSupplies[i].divideDecimal(total)
                    : 1e18 / (pools.length + relayers.length);
            weights[weekTimestamp][relayers[i]] = w;
            emit WeightUpdated(relayers[i], weekTimestamp, w);
            if (relayers[i] == pool) {
                weight = w;
            }
        }
    }

    function addScheduleRelayer(address scheduleRelayer) external onlyOwner {
        if (_scheduleRelayers.add(scheduleRelayer)) {
            emit ScheduleRelayerAdded(scheduleRelayer);
        }
    }

    function removeScheduleRelayer(address scheduleRelayer) external onlyOwner {
        if (_scheduleRelayers.remove(scheduleRelayer)) {
            emit ScheduleRelayerRemoved(scheduleRelayer);
        }
    }
}
