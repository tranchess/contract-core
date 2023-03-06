// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./IWithdrawalManager.sol";
import "./WithdrawalManagerFactory.sol";

interface IEthStakingStrategy {
    function safeStaking() external view returns (address);

    function registry() external view returns (address);

    function depositContract() external view returns (address);

    function deposit(uint256 amount) external;
}

contract NodeOperatorRegistry is Ownable {
    event OperatorAdded(uint256 indexed id, string name, address operatorOwner);
    event OperatorOwnerUpdated(uint256 indexed id, address newOperatorOwner);
    event RewardAddressUpdated(uint256 indexed id, address newRewardAddress);
    event VerifiedCountUpdated(uint256 indexed id, uint256 newVerifiedCount);
    event DepositLimitUpdated(uint256 indexed id, uint256 newDepositLimit);
    event KeyAdded(uint256 indexed id, bytes pubkey, uint256 index);
    event KeyUsed(uint256 indexed id, uint256 count);
    event KeyTruncated(uint256 indexed id, uint256 newTotalCount);
    event StrategyUpdated(address newStrategy);

    /// @notice Statistics of validator pubkeys from a node operator.
    /// @param totalCount Total number of validator pubkeys uploaded to this contract
    /// @param usedCount Number of validator pubkeys that are already used
    /// @param verifiedCount Number of validator pubkeys that are verified by the contract owner
    /// @param depositLimit Maximum number of usable validator pubkeys, set by the node operator
    struct KeyStat {
        uint64 totalCount;
        uint64 usedCount;
        uint64 verifiedCount;
        uint64 depositLimit;
    }

    /// @notice Node operator parameters and internal state
    /// @param operatorOwner Admin address of the node operator
    /// @param name Human-readable name
    /// @param withdrawalAddress Address receiving withdrawals and execution layer rewards
    /// @param rewardAddress Address receiving performance rewards
    struct Operator {
        address operatorOwner;
        string name;
        address rewardAddress;
        address withdrawalAddress;
        KeyStat keyStat;
    }

    struct Key {
        bytes32 pubkey0;
        bytes32 pubkey1; // Only the higher 16 bytes of the second slot are used
        bytes32 signature0;
        bytes32 signature1;
        bytes32 signature2;
    }

    uint256 private constant PUBKEY_LENGTH = 48;
    uint256 private constant SIGNATURE_LENGTH = 96;

    WithdrawalManagerFactory public immutable factory;

    address public strategy;

    /// @notice Number of node operators.
    uint256 public operatorCount;

    /// @dev Mapping of node operator ID => node operator.
    mapping(uint256 => Operator) private _operators;

    /// @dev Mapping of node operator ID => index => validator pubkey and deposit signature.
    mapping(uint256 => mapping(uint256 => Key)) private _keys;

    uint256 public registryVersion;

    constructor(address strategy_, address withdrawalManagerFactory_) public {
        _updateStrategy(strategy_);
        factory = WithdrawalManagerFactory(withdrawalManagerFactory_);
    }

    function initialize(address oldRegistry) external onlyOwner {
        require(operatorCount == 0);

        operatorCount = NodeOperatorRegistry(oldRegistry).operatorCount();
        for (uint256 i = 0; i < operatorCount; i++) {
            Operator memory operator = NodeOperatorRegistry(oldRegistry).getOperator(i);
            operator.operatorOwner = msg.sender;
            uint64 usedCount = operator.keyStat.usedCount;
            operator.keyStat.totalCount = usedCount;
            operator.keyStat.verifiedCount = usedCount;
            _operators[i] = operator;
            emit OperatorAdded(i, operator.name, msg.sender);
            if (operator.rewardAddress != msg.sender) {
                emit RewardAddressUpdated(i, operator.rewardAddress);
            }
            emit DepositLimitUpdated(i, operator.keyStat.depositLimit);

            Key[] memory keys = NodeOperatorRegistry(oldRegistry).getKeys(i, 0, usedCount);
            for (uint256 j = 0; j < usedCount; j++) {
                bytes32 pk0 = keys[j].pubkey0;
                bytes32 pk1 = keys[j].pubkey1;
                _keys[i][j].pubkey0 = pk0;
                _keys[i][j].pubkey1 = pk1;
                emit KeyAdded(i, abi.encodePacked(pk0, bytes16(pk1)), j);
            }
            emit VerifiedCountUpdated(i, usedCount);
            emit KeyUsed(i, usedCount);
        }
    }

    function getOperator(uint256 id) external view returns (Operator memory) {
        return _operators[id];
    }

    function getOperators() external view returns (Operator[] memory operators) {
        uint256 count = operatorCount;
        operators = new Operator[](count);
        for (uint256 i = 0; i < count; i++) {
            operators[i] = _operators[i];
        }
    }

    function getRewardAddress(uint256 id) external view returns (address) {
        return _operators[id].rewardAddress;
    }

    function getRewardAddresses() external view returns (address[] memory addresses) {
        uint256 count = operatorCount;
        addresses = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            addresses[i] = _operators[i].rewardAddress;
        }
    }

    function getWithdrawalAddress(uint256 id) external view returns (address) {
        return _operators[id].withdrawalAddress;
    }

    function getWithdrawalAddresses() external view returns (address[] memory addresses) {
        uint256 count = operatorCount;
        addresses = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            addresses[i] = _operators[i].withdrawalAddress;
        }
    }

    function getWithdrawalCredential(uint256 id) external view returns (bytes32) {
        return IWithdrawalManager(_operators[id].withdrawalAddress).getWithdrawalCredential();
    }

    function getKeyStat(uint256 id) external view returns (KeyStat memory) {
        return _operators[id].keyStat;
    }

    function getKeyStats() external view returns (KeyStat[] memory keyStats) {
        uint256 count = operatorCount;
        keyStats = new KeyStat[](count);
        for (uint256 i = 0; i < count; i++) {
            keyStats[i] = _operators[i].keyStat;
        }
    }

    function getKey(uint256 id, uint256 index) external view returns (Key memory) {
        return _keys[id][index];
    }

    function getKeys(
        uint256 id,
        uint256 start,
        uint256 count
    ) external view returns (Key[] memory keys) {
        keys = new Key[](count);
        mapping(uint256 => Key) storage operatorKeys = _keys[id];
        for (uint256 i = 0; i < count; i++) {
            keys[i] = operatorKeys[start + i];
        }
    }

    function getPubkeys(
        uint256 id,
        uint256 start,
        uint256 count
    ) external view returns (bytes[] memory pubkeys) {
        pubkeys = new bytes[](count);
        mapping(uint256 => Key) storage operatorKeys = _keys[id];
        for (uint256 i = 0; i < count; i++) {
            Key storage key = operatorKeys[start + i];
            pubkeys[i] = abi.encodePacked(key.pubkey0, bytes16(key.pubkey1));
        }
    }

    function getSignatures(
        uint256 id,
        uint256 start,
        uint256 count
    ) external view returns (bytes[] memory signatures) {
        signatures = new bytes[](count);
        mapping(uint256 => Key) storage operatorKeys = _keys[id];
        for (uint256 i = 0; i < count; i++) {
            Key storage key = operatorKeys[start + i];
            signatures[i] = abi.encode(key.signature0, key.signature1, key.signature2);
        }
    }

    function addKeys(
        uint256 id,
        bytes calldata pubkeys,
        bytes calldata signatures
    ) external onlyOperatorOwner(id) {
        uint256 count = pubkeys.length / PUBKEY_LENGTH;
        require(
            pubkeys.length == count * PUBKEY_LENGTH &&
                signatures.length == count * SIGNATURE_LENGTH,
            "Invalid param length"
        );
        mapping(uint256 => Key) storage operatorKeys = _keys[id];
        Operator storage operator = _operators[id];
        KeyStat memory stat = operator.keyStat;
        for (uint256 i = 0; i < count; ++i) {
            Key memory key;
            key.pubkey0 = abi.decode(pubkeys[i * PUBKEY_LENGTH:i * PUBKEY_LENGTH + 32], (bytes32));
            key.pubkey1 = abi.decode(
                pubkeys[i * PUBKEY_LENGTH + 16:i * PUBKEY_LENGTH + 48],
                (bytes32)
            );
            key.pubkey1 = bytes32(uint256(key.pubkey1) << 128);
            (key.signature0, key.signature1, key.signature2) = abi.decode(
                signatures[i * SIGNATURE_LENGTH:(i + 1) * SIGNATURE_LENGTH],
                (bytes32, bytes32, bytes32)
            );
            require(
                key.pubkey0 | key.pubkey1 != 0 &&
                    key.signature0 | key.signature1 | key.signature2 != 0,
                "Empty pubkey or signature"
            );
            operatorKeys[stat.totalCount + i] = key;
            emit KeyAdded(
                id,
                abi.encodePacked(key.pubkey0, bytes16(key.pubkey1)),
                stat.totalCount + i
            );
        }
        stat.totalCount += uint64(count);
        operator.keyStat = stat;
        registryVersion++;
    }

    function truncateUnusedKeys(uint256 id) external onlyOperatorOwner(id) {
        _truncateUnusedKeys(id);
    }

    function updateRewardAddress(uint256 id, address newRewardAddress)
        external
        onlyOperatorOwner(id)
    {
        _operators[id].rewardAddress = newRewardAddress;
        emit RewardAddressUpdated(id, newRewardAddress);
    }

    function updateDepositLimit(uint256 id, uint64 newDepositLimit) external onlyOperatorOwner(id) {
        _operators[id].keyStat.depositLimit = newDepositLimit;
        registryVersion++;
        emit DepositLimitUpdated(id, newDepositLimit);
    }

    function useKeys(uint256 id, uint256 count)
        external
        onlyStrategy
        returns (Key[] memory keys, bytes32 withdrawalCredential)
    {
        Operator storage operator = _operators[id];
        KeyStat memory stat = operator.keyStat;
        mapping(uint256 => Key) storage operatorKeys = _keys[id];
        uint256 usedCount = stat.usedCount;
        uint256 newUsedCount = usedCount + count;
        require(
            newUsedCount <= stat.totalCount &&
                newUsedCount <= stat.depositLimit &&
                newUsedCount <= stat.verifiedCount,
            "No enough pubkeys"
        );
        keys = new Key[](count);
        for (uint256 i = 0; i < count; i++) {
            Key storage k = operatorKeys[usedCount + i];
            keys[i] = k;
            // Clear storage for gas refund
            k.signature0 = 0;
            k.signature1 = 0;
            k.signature2 = 0;
        }
        stat.usedCount = uint64(newUsedCount);
        operator.keyStat = stat;
        withdrawalCredential = IWithdrawalManager(operator.withdrawalAddress)
            .getWithdrawalCredential();
        registryVersion++;
        emit KeyUsed(id, count);
    }

    function addOperator(string calldata name, address operatorOwner)
        external
        onlyOwner
        returns (uint256 id, address withdrawalAddress)
    {
        id = operatorCount++;
        withdrawalAddress = factory.deployContract(id);
        Operator storage operator = _operators[id];
        operator.operatorOwner = operatorOwner;
        operator.name = name;
        operator.withdrawalAddress = withdrawalAddress;
        operator.rewardAddress = operatorOwner;
        emit OperatorAdded(id, name, operatorOwner);
    }

    function updateOperatorOwner(uint256 id, address newOperatorOwner) external onlyOwner {
        require(id < operatorCount, "Invalid operator ID");
        _operators[id].operatorOwner = newOperatorOwner;
        emit OperatorOwnerUpdated(id, newOperatorOwner);
    }

    function updateVerifiedCount(
        uint256 id,
        uint64 newVerifiedCount,
        uint256 offchainregistryVersion
    ) external {
        require(msg.sender == IEthStakingStrategy(strategy).safeStaking(), "Only safe staking");
        require(registryVersion == offchainregistryVersion, "Registry version changed");

        _operators[id].keyStat.verifiedCount = newVerifiedCount;
        registryVersion++;
        emit VerifiedCountUpdated(id, newVerifiedCount);
    }

    function truncateAllUnusedKeys() external onlyOwner {
        uint256 count = operatorCount;
        for (uint256 i = 0; i < count; i++) {
            _truncateUnusedKeys(i);
        }
    }

    function _truncateUnusedKeys(uint256 id) private {
        Operator storage operator = _operators[id];
        KeyStat memory stat = operator.keyStat;
        stat.totalCount = stat.usedCount;
        stat.verifiedCount = stat.usedCount;
        operator.keyStat = stat;
        emit KeyTruncated(id, stat.totalCount);
    }

    function updateStrategy(address newStrategy) external onlyOwner {
        _updateStrategy(newStrategy);
    }

    function _updateStrategy(address newStrategy) private {
        strategy = newStrategy;
        emit StrategyUpdated(newStrategy);
    }

    modifier onlyOperatorOwner(uint256 id) {
        require(msg.sender == _operators[id].operatorOwner, "Only operator owner");
        _;
    }

    modifier onlyStrategy() {
        require(msg.sender == strategy, "Only strategy");
        _;
    }
}
