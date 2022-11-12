// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/SafeDecimalMath.sol";
import "../interfaces/IFundV3.sol";

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
    event BeaconConfigUpdated(
        uint256 newEpochsPerFrame,
        uint256 newSlotsPerEpoch,
        uint256 newSecondsPerSlot,
        uint256 newGenesisTime
    );
    event SanityBoundaryUpdated(uint256 newAnnualMaxIncrease, uint256 newInstantMaxDecrease);
    event QuorumUpdated(uint256 newQuorum);

    /// Eth1 denomination is 18 digits, while Eth2 has 9 digits. Because we work with Eth2
    /// balances and to support old interfaces expecting eth1 format, we multiply by this
    /// coefficient.
    uint256 public constant DENOMINATION_OFFSET = 1e9;

    uint256 public immutable maxMember;

    IEthStakingStrategy public strategy;
    IFundV3 public fund;
    uint256 public epochsPerFrame;
    uint256 public slotsPerEpoch;
    uint256 public secondsPerSlot;
    uint256 public genesisTime;
    uint256 public annualMaxIncrease;
    uint256 public instantMaxDecrease;

    /// @notice Number of exactly the same reports needed to finalize the epoch
    /// Not all frames may come to a quorum. Oracles may report only to the first
    /// epoch of the frame and only if no quorum is reached for this epoch yet.
    uint256 public quorum;
    uint256 public salt;
    uint256 public expectedEpoch;
    uint256 public lastCompletedEpoch;

    /// @dev Epoch head => message hash => count
    mapping(uint256 => mapping(bytes32 => uint256)) private _reports;

    /// @dev Oracle members => epoch Id of the most recent reported frame
    mapping(address => uint256) private _reported;

    EnumerableSet.AddressSet private _members;

    constructor(
        address strategy_,
        uint256 epochsPerFrame_,
        uint256 slotsPerEpoch_,
        uint256 secondsPerSlot_,
        uint256 genesisTime_,
        uint256 annualMaxIncrease_,
        uint256 instantMaxDecrease_,
        uint256 quorum_,
        uint256 maxMember_
    ) public {
        strategy = IEthStakingStrategy(strategy_);
        fund = IFundV3(IEthStakingStrategy(strategy_).fund());
        _updateBeaconConfig(epochsPerFrame_, slotsPerEpoch_, secondsPerSlot_, genesisTime_);
        _updateSanityBoundary(annualMaxIncrease_, instantMaxDecrease_);
        _updateQuorum(quorum_);
        maxMember = maxMember_;
    }

    /// @notice Accept oracle committee member reports from the ETH 2.0 side
    /// @param epochId Beacon chain epoch
    /// @param ids Operator IDs
    /// @param beaconBalances Balance in gwei on the ETH 2.0 side (9-digit denomination)
    /// @param validatorCounts Number of validators visible in this epoch
    function reportBeacon(
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
        require(_reported[msg.sender] < expectedEpoch, "Already submitted");
        _reported[msg.sender] = expectedEpoch;

        // Convert eth2 balances to eth1
        uint256[] memory eth1Balances = new uint256[](beaconBalances.length);
        for (uint256 i = 0; i < eth1Balances.length; i++) {
            eth1Balances[i] = beaconBalances[i] * DENOMINATION_OFFSET;
        }

        // Push the result to `_reports` queue, report to strategy if counts exceed `quorum`
        bytes32 report = keccak256(abi.encodePacked(ids, beaconBalances, validatorCounts, salt));
        uint256 currentCount = _reports[expectedEpoch][report] + 1;
        _reports[expectedEpoch][report] = currentCount;
        if (currentCount >= quorum) {
            uint256 prevTotalEther = fund.getTotalUnderlying();
            strategy.batchReport(epochId, ids, eth1Balances, validatorCounts);
            uint256 postTotalEther = fund.getTotalUnderlying();

            uint256 timeElapsed = (epochId - lastCompletedEpoch) * slotsPerEpoch * secondsPerSlot;
            lastCompletedEpoch = epochId;

            _reportSanityChecks(postTotalEther, prevTotalEther, timeElapsed);

            // Move the expectedEpoch to the first epoch of the next frame
            expectedEpoch = epochId + epochsPerFrame;
        }

        emit BeaconReported(epochId, eth1Balances, validatorCounts, msg.sender);
    }

    /// @dev Performs logical consistency check of the underlying changes as the result of reports push
    function _reportSanityChecks(
        uint256 postTotalEther,
        uint256 preTotalEther,
        uint256 timeElapsed
    ) internal view {
        if (postTotalEther >= preTotalEther) {
            // increase             = (postTotalEther - preTotalEther) * 365 days
            // maxAnnualIncrease    = preTotalEther * annualMaxIncrease * timeElapsed
            //
            // check that increase <= maxAnnualIncrease
            require(
                uint256(365 days).mul(postTotalEther - preTotalEther) <=
                    preTotalEther.mul(timeElapsed).multiplyDecimal(annualMaxIncrease),
                "Annual max increase"
            );
        } else {
            // decrease             = preTotalEther - postTotalEther
            // maxInstantDecrease   = preTotalEther * instantMaxDecrease
            //
            // check that decrease <= maxInstantDecrease
            require(
                preTotalEther - postTotalEther <= preTotalEther.multiplyDecimal(instantMaxDecrease),
                "Instant max decrease"
            );
        }
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

    function addOracleMember(address member) external onlyOwner {
        require(member != address(0), "Invalid address");
        require(!_members.contains(member), "Already a member");
        require(_members.length() < maxMember, "Too many members");

        _members.add(member);

        emit MemberAdded(member);
    }

    function removeOracleMember(address member) external onlyOwner {
        require(_members.contains(member), "Not a member");
        _members.remove(member);
        emit MemberRemoved(member);

        // Increment `salt` to force out the previous records, and allow the remained oracles
        // to report it again
        salt++;
    }

    function updateBeaconConfig(
        uint256 newEpochsPerFrame,
        uint256 newSlotsPerEpoch,
        uint256 newSecondsPerSlot,
        uint256 newGenesisTime
    ) external onlyOwner {
        _updateBeaconConfig(newEpochsPerFrame, newSlotsPerEpoch, newSecondsPerSlot, newGenesisTime);
    }

    function updateSanityBoundary(uint256 newAnnualMaxIncrease, uint256 newInstantMaxDecrease)
        external
        onlyOwner
    {
        _updateSanityBoundary(newAnnualMaxIncrease, newInstantMaxDecrease);
    }

    function updateQuorum(uint256 newQuorum) external onlyOwner {
        _updateQuorum(newQuorum);
    }

    function _updateBeaconConfig(
        uint256 newEpochsPerFrame,
        uint256 newSlotsPerEpoch,
        uint256 newSecondsPerSlot,
        uint256 newGenesisTime
    ) private {
        require(newEpochsPerFrame > 0, "BAD_EPOCHS_PER_FRAME");
        require(newSlotsPerEpoch > 0, "BAD_SLOTS_PER_EPOCH");
        require(newSecondsPerSlot > 0, "BAD_SECONDS_PER_SLOT");
        require(newGenesisTime > 0, "BAD_GENESIS_TIME");
        epochsPerFrame = newEpochsPerFrame;
        slotsPerEpoch = newSlotsPerEpoch;
        secondsPerSlot = newSecondsPerSlot;
        genesisTime = newGenesisTime;
        emit BeaconConfigUpdated(
            newEpochsPerFrame,
            newSlotsPerEpoch,
            newSecondsPerSlot,
            newGenesisTime
        );
    }

    function _updateSanityBoundary(uint256 newAnnualMaxIncrease, uint256 newInstantMaxDecrease)
        private
    {
        annualMaxIncrease = newAnnualMaxIncrease;
        instantMaxDecrease = newInstantMaxDecrease;
        emit SanityBoundaryUpdated(newAnnualMaxIncrease, newInstantMaxDecrease);
    }

    function _updateQuorum(uint256 newQuorum) private {
        quorum = newQuorum;
        emit QuorumUpdated(newQuorum);
    }
}
