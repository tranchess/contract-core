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
        uint256[] beaconBalance,
        uint256[] beaconValidators,
        address caller
    );
    event MemberAdded(address member);
    event MemberRemoved(address member);
    event SanityBoundaryUpdated(uint256 newAnnualMaxChange);
    event QuorumUpdated(uint256 newQuorum);

    uint256 public immutable epochsPerFrame;
    uint256 public immutable slotsPerEpoch;
    uint256 public immutable secondsPerSlot;
    uint256 public immutable genesisTime;

    IEthStakingStrategy public strategy;
    IFundV3 public fund;
    uint256 public annualMaxChange;

    /// @notice Number of exactly the same reports needed to finalize the epoch
    /// Not all frames may come to a quorum. Oracles may report only to the first
    /// epoch of the frame and only if no quorum is reached for this epoch yet.
    uint256 public quorum;
    uint256 public salt;
    uint256 public expectedEpoch;
    uint256 public lastCompletedEpoch;

    /// @dev Epoch head => message hash => count
    mapping(uint256 => mapping(bytes32 => uint256)) public reports;

    /// @dev Oracle members => epoch Id of the most recent reported frame
    mapping(address => uint256) public reported;

    EnumerableSet.AddressSet private _members;

    constructor(
        address strategy_,
        uint256 epochsPerFrame_,
        uint256 slotsPerEpoch_,
        uint256 secondsPerSlot_,
        uint256 genesisTime_,
        uint256 annualMaxChange_,
        uint256 quorum_
    ) public {
        strategy = IEthStakingStrategy(strategy_);
        fund = IFundV3(IEthStakingStrategy(strategy_).fund());
        epochsPerFrame = epochsPerFrame_;
        slotsPerEpoch = slotsPerEpoch_;
        secondsPerSlot = secondsPerSlot_;
        genesisTime = genesisTime_;
        _updateSanityBoundary(annualMaxChange_);
        _updateQuorum(quorum_);
    }

    /// @notice Accept oracle committee member reports from the ETH 2.0 side
    /// @param epochId Beacon chain epoch
    /// @param ids Operator IDs
    /// @param beaconBalances Balance in gwei on the ETH 2.0 side (9-digit denomination)
    /// @param validatorCounts Number of validators visible in this epoch
    function batchReport(
        uint256 epochId,
        uint256[] memory ids,
        uint256[] memory beaconBalances,
        uint256[] memory validatorCounts
    ) external onlyMember {
        // If expected epoch has advanced, check that this is the first epoch of the new frame
        require(epochId >= expectedEpoch, "Stale epoch");
        if (epochId > expectedEpoch) {
            uint256 currentEpochId = _getCurrentEpochId(genesisTime, slotsPerEpoch, secondsPerSlot);
            require(
                epochId == _getFrameFirstEpochId(currentEpochId, epochsPerFrame),
                "Invalid epoch"
            );
            expectedEpoch = epochId;
        }

        // Make sure the oracle is from members list and has not yet voted
        require(reported[msg.sender] < expectedEpoch, "Already submitted");
        reported[msg.sender] = expectedEpoch;

        // Push the result to `reports` queue, report to strategy if counts exceed `quorum`
        bytes32 report = keccak256(abi.encodePacked(ids, beaconBalances, validatorCounts, salt));
        uint256 currentCount = reports[expectedEpoch][report] + 1;
        reports[expectedEpoch][report] = currentCount;
        if (currentCount >= quorum) {
            uint256 prevTotalEther = fund.getTotalUnderlying();
            strategy.batchReport(epochId, ids, beaconBalances, validatorCounts);
            uint256 postTotalEther = fund.getTotalUnderlying();

            uint256 timeElapsed = (epochId - lastCompletedEpoch) * slotsPerEpoch * secondsPerSlot;
            lastCompletedEpoch = epochId;

            _reportSanityChecks(postTotalEther, prevTotalEther, timeElapsed);

            // Move the expectedEpoch to the first epoch of the next frame
            expectedEpoch = epochId + epochsPerFrame;
        }

        emit BeaconReported(epochId, beaconBalances, validatorCounts, msg.sender);
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

    /// @return epochId the epoch calculated from current timestamp
    function _getCurrentEpochId(
        uint256 genesis,
        uint256 slots,
        uint256 slotTime
    ) private view returns (uint256 epochId) {
        epochId = (block.timestamp - genesis) / (slots * slotTime);
    }

    /// @return firstEpochId the first epoch of the frame that `epochId` belongs to
    function _getFrameFirstEpochId(uint256 epochId, uint256 epochs)
        private
        pure
        returns (uint256 firstEpochId)
    {
        firstEpochId = (epochId / epochs) * epochs;
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

        // Increment `salt` to force out the previous records, and allow the remained oracles
        // to report it again
        salt++;
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
