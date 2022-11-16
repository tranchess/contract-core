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
    event AnnualMaxChangeUpdated(uint256 newAnnualMaxChange);
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
        _updateAnnualMaxChange(annualMaxChange_);
    }

    /// @notice Report validator balances on Beacon chain
    /// @param epoch Beacon chain epoch
    /// @param ids Node operator IDs, which must be sorted in ascending order
    /// @param beaconBalances Balance in wei of all validators of each node operator
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
            uint256 preTotalUnderlying = fund.getTotalUnderlying();
            strategy.batchReport(epoch, ids, beaconBalances, validatorCounts);
            uint256 postTotalUnderlying = fund.getTotalUnderlying();

            uint256 timeElapsed = (epoch - lastCompletedEpoch) * secondsPerEpoch;
            _sanityCheck(postTotalUnderlying, preTotalUnderlying, timeElapsed);
            lastCompletedEpoch = epoch;
        }
    }

    /// @dev Performs logical consistency check of the underlying changes as the result of reports push
    function _sanityCheck(
        uint256 postTotalUnderlying,
        uint256 preTotalUnderlying,
        uint256 timeElapsed
    ) private view {
        uint256 delta =
            postTotalUnderlying >= preTotalUnderlying
                ? postTotalUnderlying - preTotalUnderlying
                : preTotalUnderlying - postTotalUnderlying;
        require(
            delta.mul(365 days) / timeElapsed <=
                preTotalUnderlying.multiplyDecimal(annualMaxChange),
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

    function updateAnnualMaxChange(uint256 newAnnualMaxChange) external onlyOwner {
        _updateAnnualMaxChange(newAnnualMaxChange);
    }

    function updateQuorum(uint256 newQuorum) external onlyOwner {
        _updateQuorum(newQuorum);
    }

    function _updateAnnualMaxChange(uint256 newAnnualMaxChange) private {
        annualMaxChange = newAnnualMaxChange;
        emit AnnualMaxChangeUpdated(newAnnualMaxChange);
    }

    function _updateQuorum(uint256 newQuorum) private {
        quorum = newQuorum;
        emit QuorumUpdated(newQuorum);
    }
}
