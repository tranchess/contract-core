// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../../utils/SafeDecimalMath.sol";
import "../../interfaces/IFundV3.sol";

interface IEthStakingStrategy {
    function fund() external view returns (address);

    function batchReport(
        uint256 epoch,
        uint256[] memory ids,
        uint256[] memory beaconBalances,
        uint256[] memory validatorCounts
    ) external;
}

/// @title ETH Beacon Chain staking oracle
/// @notice Implementation of an ETH 2.0 -> ETH oracle
/// @dev Beacon balances can go up because of reward accumulation and down because of slashing.
contract BeaconStakingOracle is Ownable {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    event BeaconReported(
        uint256 epochId,
        uint256[] ids,
        uint256[] beaconBalance,
        uint256[] beaconValidators,
        address caller
    );
    event MemberAdded(address member);
    event MemberRemoved(address member);
    event SanityBoundaryUpdated(uint256 newAnnualMaxChange);
    event QuorumUpdated(uint256 newQuorum);

    /// @notice Number of epochs between adjacent reports
    uint256 public immutable reportableEpochInterval;

    uint256 public immutable secondsPerEpoch;

    /// @notice Timestamp of epoch 0
    uint256 public immutable genesisTime;

    IEthStakingStrategy public strategy;
    IFundV3 public fund;
    uint256 public annualMaxChange;

    /// @notice Number of exactly the same reports needed to finalize the epoch
    /// Not all frames may come to a quorum. Oracles may report only to the first
    /// epoch of the frame and only if no quorum is reached for this epoch yet.
    uint256 public quorum;
    uint256 public lastCompletedEpoch;

    /// @notice Epoch => report hash => received count
    mapping(uint256 => mapping(bytes32 => uint256)) public reports;

    /// @dev Oracle members => epoch Id of the most recent reported frame
    mapping(address => uint256) public reported;

    EnumerableSet.AddressSet private _members;

    constructor(
        address strategy_,
        uint256 reportableEpochInterval_,
        uint256 secondsPerEpoch_,
        uint256 genesisTime_,
        uint256 annualMaxChange_
    ) public {
        strategy = IEthStakingStrategy(strategy_);
        fund = IFundV3(IEthStakingStrategy(strategy_).fund());
        reportableEpochInterval = reportableEpochInterval_;
        secondsPerEpoch = secondsPerEpoch_;
        require(genesisTime_ < block.timestamp);
        genesisTime = genesisTime_;
        _updateSanityBoundary(annualMaxChange_);
    }

    /// @notice Accept oracle committee member reports from the ETH 2.0 side
    /// @param epoch Beacon chain epoch
    /// @param ids Operator IDs
    /// @param beaconBalances Balance in gwei on the ETH 2.0 side (9-digit denomination)
    /// @param validatorCounts Number of validators visible in this epoch
    function batchReport(
        uint256 epoch,
        uint256[] memory ids,
        uint256[] memory beaconBalances,
        uint256[] memory validatorCounts
    ) external onlyMember {
        require(
            epoch <= getLatestReportableEpoch() &&
                epoch > lastCompletedEpoch &&
                epoch % reportableEpochInterval == 0,
            "Invalid epoch"
        );
        require(reported[msg.sender] < epoch, "Already reported");
        reported[msg.sender] = epoch;

        // Push the result to `reports` queue, report to strategy if counts exceed `quorum`
        bytes32 report = encodeBatchReport(ids, beaconBalances, validatorCounts);
        uint256 currentCount = reports[epoch][report] + 1;
        reports[epoch][report] = currentCount;
        emit BeaconReported(epoch, ids, beaconBalances, validatorCounts, msg.sender);

        if (currentCount >= quorum) {
            uint256 prevTotalEther = fund.getTotalUnderlying();
            strategy.batchReport(epoch, ids, beaconBalances, validatorCounts);
            uint256 postTotalEther = fund.getTotalUnderlying();

            uint256 timeElapsed = (epoch - lastCompletedEpoch) * secondsPerEpoch;
            _reportSanityChecks(postTotalEther, prevTotalEther, timeElapsed);
            lastCompletedEpoch = epoch;
        }
    }

    /// @dev Performs logical consistency check of the underlying changes as the result of reports push
    function _reportSanityChecks(
        uint256 postTotalEther,
        uint256 preTotalEther,
        uint256 timeElapsed
    ) internal view {
        uint256 totalEtherDelta =
            postTotalEther >= preTotalEther
                ? postTotalEther - preTotalEther
                : preTotalEther - postTotalEther;
        require(
            uint256(365 days).mul(totalEtherDelta) <=
                preTotalEther.mul(timeElapsed).multiplyDecimal(annualMaxChange),
            "Annual max delta"
        );
    }

    /// @notice Return the latest reportable epoch
    function getLatestReportableEpoch() public view returns (uint256) {
        uint256 latestEpoch = (block.timestamp - genesisTime) / secondsPerEpoch;
        return (latestEpoch / reportableEpochInterval) * reportableEpochInterval;
    }

    function encodeBatchReport(
        uint256[] memory ids,
        uint256[] memory beaconBalances,
        uint256[] memory validatorCounts
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(ids, beaconBalances, validatorCounts));
    }

    modifier onlyMember() {
        require(_members.contains(msg.sender), "Member not found");
        _;
    }

    function getMemberCount() external view returns (uint256) {
        return _members.length();
    }

    function getMember(uint256 index) external view returns (address) {
        return _members.at(index);
    }

    function addOracleMember(address member, uint256 newQuorum) external onlyOwner {
        require(member != address(0), "Invalid address");
        require(!_members.contains(member), "Already a member");
        _members.add(member);
        emit MemberAdded(member);

        _updateQuorum(newQuorum);
    }

    function removeOracleMember(address member, uint256 newQuorum) external onlyOwner {
        require(_members.contains(member), "Not a member");
        _members.remove(member);
        emit MemberRemoved(member);

        _updateQuorum(newQuorum);
    }

    function updateSanityBoundary(uint256 newAnnualMaxChange) external onlyOwner {
        _updateSanityBoundary(newAnnualMaxChange);
    }

    function updateQuorum(uint256 newQuorum) external onlyOwner {
        _updateQuorum(newQuorum);
    }

    function _updateSanityBoundary(uint256 newAnnualMaxChange) private {
        annualMaxChange = newAnnualMaxChange;
        emit SanityBoundaryUpdated(newAnnualMaxChange);
    }

    function _updateQuorum(uint256 newQuorum) private {
        quorum = newQuorum;
        emit QuorumUpdated(newQuorum);
    }
}
