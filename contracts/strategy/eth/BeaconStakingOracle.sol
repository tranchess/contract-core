// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../../utils/SafeDecimalMath.sol";
import "../../interfaces/IFundV3.sol";

interface IEthStakingStrategy {
    struct OperatorData {
        uint256 id;
        uint256 beaconBalance;
        uint256 validatorCount;
        uint256 executionLayerReward;
    }

    function fund() external view returns (address);

    function batchReport(
        uint256 epoch,
        OperatorData[] calldata operatorData,
        uint256 finalizationCount
    ) external;
}

contract BeaconStakingOracle is Ownable {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    event BeaconReported(uint256 epochId, bytes32 report, address caller);
    event MemberAdded(address member);
    event MemberRemoved(address member);
    event AnnualMaxChangeUpdated(uint256 newAnnualMaxChange);
    event QuorumUpdated(uint256 newQuorum);

    IEthStakingStrategy public immutable strategy;
    IFundV3 public immutable fund;

    /// @notice Number of epochs between adjacent reports
    uint256 public immutable reportableEpochInterval;

    uint256 public immutable secondsPerEpoch;

    /// @notice Timestamp of epoch 0
    uint256 public immutable genesisTime;

    uint256 public annualMaxChange;

    /// @notice Number of exactly the same reports needed to finalize the epoch
    uint256 public quorum;
    uint256 public nonce;
    uint256 public lastCompletedEpoch;

    /// @notice Epoch => report hash => received count
    mapping(uint256 => mapping(bytes32 => uint256)) public reports;

    /// @dev Oracle member => epoch of the most recent report
    mapping(address => uint256) public lastReportedEpoch;

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
    /// @param operatorData Per-operator report data including Node operator IDs, which must be sorted in ascending order
    /// @param finalizationCount Number of finalizable redemptions
    function batchReport(
        uint256 epoch,
        IEthStakingStrategy.OperatorData[] calldata operatorData,
        uint256 finalizationCount
    ) external onlyMember {
        require(
            epoch <= getLatestReportableEpoch() &&
                epoch > lastCompletedEpoch &&
                epoch % reportableEpochInterval == 0,
            "Invalid epoch"
        );
        require(lastReportedEpoch[msg.sender] < epoch, "Already reported");
        lastReportedEpoch[msg.sender] = epoch;

        // Push the result to `reports` queue, report to strategy if counts exceed `quorum`
        bytes32 report = encodeBatchReport(operatorData, finalizationCount);
        uint256 currentCount = reports[epoch][report] + 1;
        emit BeaconReported(epoch, report, msg.sender);

        if (currentCount >= quorum) {
            uint256 preTotalUnderlying = fund.getTotalUnderlying();
            uint256 preEquivalentTotalQ = fund.getEquivalentTotalQ();
            strategy.batchReport(epoch, operatorData, finalizationCount);
            uint256 postTotalUnderlying = fund.getTotalUnderlying();
            uint256 postEquivalentTotalQ = fund.getEquivalentTotalQ();

            uint256 timeElapsed = (epoch - lastCompletedEpoch) * secondsPerEpoch;
            _sanityCheck(
                postTotalUnderlying,
                postEquivalentTotalQ,
                preTotalUnderlying,
                preEquivalentTotalQ,
                timeElapsed
            );
            lastCompletedEpoch = epoch;

            if (currentCount > 1) {
                reports[epoch][report] = 0; // Clear storage for gas refund
            }
        } else {
            reports[epoch][report] = currentCount;
        }
    }

    /// @dev Performs logical consistency check of the underlying changes as the result of reports push
    function _sanityCheck(
        uint256 postTotalUnderlying,
        uint256 postEquivalentTotalQ,
        uint256 preTotalUnderlying,
        uint256 preEquivalentTotalQ,
        uint256 timeElapsed
    ) private view {
        if (postEquivalentTotalQ == 0 || preEquivalentTotalQ == 0) {
            return;
        }
        uint256 postNav = postTotalUnderlying.divideDecimal(postEquivalentTotalQ);
        uint256 preNav = preTotalUnderlying.divideDecimal(preEquivalentTotalQ);
        uint256 delta = postNav >= preNav ? postNav - preNav : preNav - postNav;
        require(
            delta.mul(365 days) / timeElapsed <= preNav.multiplyDecimal(annualMaxChange),
            "Annual max delta"
        );
    }

    /// @notice Return the latest reportable epoch
    function getLatestReportableEpoch() public view returns (uint256) {
        uint256 latestEpoch = (block.timestamp - genesisTime) / secondsPerEpoch;
        return (latestEpoch / reportableEpochInterval) * reportableEpochInterval;
    }

    function encodeBatchReport(
        IEthStakingStrategy.OperatorData[] calldata operatorData,
        uint256 finalizationCount
    ) public view returns (bytes32) {
        return keccak256(abi.encode(operatorData, finalizationCount, nonce));
    }

    /// @notice Return the epoch that an oracle member should report now,
    ///         or zero if the latest reportable epoch is already reported.
    function getNextEpochByMember(address member) external view returns (uint256) {
        uint256 epoch = getLatestReportableEpoch();
        uint256 last = lastReportedEpoch[member];
        return epoch > last ? epoch : 0;
    }

    modifier onlyMember() {
        require(_members.contains(msg.sender), "Member not found");
        _;
    }

    function getMemberCount() external view returns (uint256) {
        return _members.length();
    }

    function getMembers() external view returns (address[] memory members) {
        uint256 length = _members.length();
        members = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            members[i] = _members.at(i);
        }
    }

    function addMember(address member, uint256 newQuorum) external onlyOwner {
        require(member != address(0), "Invalid address");
        require(!_members.contains(member), "Already a member");
        _members.add(member);
        emit MemberAdded(member);

        _updateQuorum(newQuorum);
    }

    function removeMember(address member, uint256 newQuorum) external onlyOwner {
        require(_members.contains(member), "Not a member");
        _members.remove(member);
        emit MemberRemoved(member);

        _updateQuorum(newQuorum);

        // Force out the previous records, and allow the remained oracles to report it again
        nonce++;
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
