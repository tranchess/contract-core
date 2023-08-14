// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "./NodeOperatorRegistry.sol";

interface IDepositContractView {
    function get_deposit_root() external view returns (bytes32 rootHash);
}

contract SafeStaking is Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    event MaxDepositAmountUpdated(uint256 newMaxDepositAmount);
    event MinDepositTimeIntervalUpdated(uint256 newMinDepositTimeInterval);
    event SafeguardAndQuorumUpdated(address[] newSafeguards, uint256 newQuorum);
    event Paused(address safeguard);
    event Unpaused();

    bytes32 private immutable DEPOSIT_MESSAGE_PREFIX;
    bytes32 private immutable KEY_VERIFY_MESSAGE_PREFIX;
    bytes32 private immutable PAUSE_MESSAGE_PREFIX;

    IEthStakingStrategy public immutable strategy;
    IDepositContractView public immutable depositContract;
    NodeOperatorRegistry public immutable registry;

    uint256 public maxDepositAmount;
    uint256 public minDepositTimeInterval;

    EnumerableSet.AddressSet private _safeguards;
    uint256 public quorum;

    bool public paused;
    uint256 public lastDepositTimestamp;

    constructor(
        address strategy_,
        uint256 maxDepositAmount_,
        uint256 minDepositTimeInterval_
    ) public {
        strategy = IEthStakingStrategy(strategy_);
        depositContract = IDepositContractView(IEthStakingStrategy(strategy_).depositContract());
        registry = NodeOperatorRegistry(IEthStakingStrategy(strategy_).registry());
        uint256 chainID = _getChainID();
        DEPOSIT_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(keccak256("chess.SafeStaking.DEPOSIT_MESSAGE"), chainID)
        );
        KEY_VERIFY_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(keccak256("chess.SafeStaking.KEY_VERIFY_MESSAGE"), chainID)
        );
        PAUSE_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(keccak256("chess.SafeStaking.PAUSE_MESSAGE"), chainID)
        );

        _updateMaxDepositAmount(maxDepositAmount_);
        _updateMinDepositTimeInterval(minDepositTimeInterval_);
    }

    function _getChainID() private pure returns (uint256 id) {
        assembly {
            id := chainid()
        }
    }

    function getSafeguards() external view returns (address[] memory guards) {
        uint256 length = _safeguards.length();
        guards = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            guards[i] = _safeguards.at(i);
        }
    }

    function isSafeguard(address addr) public view returns (bool) {
        return _safeguards.contains(addr);
    }

    function updateMaxDepositAmount(uint256 newMaxDepositAmount) external onlyOwner {
        _updateMaxDepositAmount(newMaxDepositAmount);
    }

    function updateMinDepositTimeInterval(uint256 newMinDepositTimeInterval) external onlyOwner {
        _updateMinDepositTimeInterval(newMinDepositTimeInterval);
    }

    function updateSafeguardAndQuorum(
        address[] calldata newSafeguards,
        uint256 newQuorum
    ) external onlyOwner {
        // Deletion in reverse order
        uint256 length = _safeguards.length();
        for (uint256 i = 0; i < length; i++) {
            _safeguards.remove(_safeguards.at(length - i - 1));
        }

        for (uint256 i = 0; i < newSafeguards.length; i++) {
            _safeguards.add(newSafeguards[i]);
        }

        require(newQuorum > 0, "Invalid quorum");
        quorum = newQuorum;

        emit SafeguardAndQuorumUpdated(newSafeguards, newQuorum);
    }

    function _updateMaxDepositAmount(uint256 newMaxDepositAmount) private {
        maxDepositAmount = newMaxDepositAmount;
        emit MaxDepositAmountUpdated(newMaxDepositAmount);
    }

    function _updateMinDepositTimeInterval(uint256 newMinDepositTimeInterval) private {
        require(newMinDepositTimeInterval > 0, "Invalid value");
        minDepositTimeInterval = newMinDepositTimeInterval;
        emit MinDepositTimeIntervalUpdated(newMinDepositTimeInterval);
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    /// @dev Pauses the contract given that both conditions:
    ///         1. The function is called by the safeguard OR the signature is valid
    ///         2. block.timestamp <= timestamp
    ///
    ///      The signature, if present, must be produced for keccak256 hash of the following
    ///      message (each component taking 32 bytes):
    ///
    ///      | PAUSE_MESSAGE_PREFIX | timestamp |
    function pause(uint256 timestamp, bytes memory signature) external whenNotPaused {
        address safeguardAddr = msg.sender;
        if (!isSafeguard(safeguardAddr)) {
            bytes32 msgHash = keccak256(abi.encodePacked(PAUSE_MESSAGE_PREFIX, timestamp));
            safeguardAddr = ECDSA.recover(msgHash, signature);
            require(isSafeguard(safeguardAddr), "Invalid signature");
        }

        require(block.timestamp <= timestamp, "Pause intent expired");

        paused = true;
        emit Paused(safeguardAddr);
    }

    function unpause() external onlyOwner {
        if (paused) {
            paused = false;
            emit Unpaused();
        }
    }

    /// @dev whether `safeDeposit` can be called, given that
    ///         1. The contract is not paused
    ///         2. The contract has been initalized
    ///         3. the last deposit was made at least `minDepositTimeInterval` seconds ago
    /// @return canDeposit whether `safeDeposit` can be called
    function canDeposit() external view returns (bool) {
        return
            !paused &&
            quorum > 0 &&
            block.timestamp - lastDepositTimestamp >= minDepositTimeInterval;
    }

    /// @dev Calls EthStakingStrategy.deposit(amount).
    ///      Reverts if any of the following is true:
    ///         1. depositRoot != depositContract.get_deposit_root()
    ///         2. registryVersion != registry.version()
    ///         3. The number of safeguard signatures is less than safeguard quorum
    ///         4. An invalid or non-safeguard signature received
    ///         5. depositAmount > maxDepositAmount
    ///         6. block.timestamp - getlastDepositTimestamp() < minDepositTimeInterval
    ///         7. blockHash != blockhash(blockNumber)
    ///
    ///      Signatures must be sorted in ascending order by address of the safeguards. Each signature must
    ///      be produced for keccak256 hash of the following message (each component taking 32 bytes):
    ///
    ///      | DEPOSIT_MESSAGE_PREFIX | depositRoot | registryVersion | blockNumber | blockHash | depositAmount
    function safeDeposit(
        bytes32 depositRoot,
        uint256 registryVersion,
        uint256 blockNumber,
        bytes32 blockHash,
        uint256 depositAmount,
        bytes memory signatures
    ) external whenNotPaused {
        require(depositRoot == depositContract.get_deposit_root(), "Deposit root changed");
        require(registryVersion == registry.registryVersion(), "Registry version changed");
        require(depositAmount <= maxDepositAmount, "Deposit amount exceeds max one-time deposit");
        require(
            block.timestamp - lastDepositTimestamp >= minDepositTimeInterval,
            "Too frequent deposits"
        );
        require(
            blockHash != bytes32(0) && blockhash(blockNumber) == blockHash,
            "Unexpected blockhash"
        );

        bytes32 msgHash = keccak256(
            abi.encodePacked(
                DEPOSIT_MESSAGE_PREFIX,
                depositRoot,
                registryVersion,
                blockNumber,
                blockHash,
                depositAmount
            )
        );
        _verifySignatures(msgHash, signatures);

        strategy.deposit(depositAmount);
        lastDepositTimestamp = block.timestamp;
    }

    function safeVerifyKeys(
        uint256 id,
        uint64 newVerifiedCount,
        uint256 registryVersion,
        bytes memory signatures
    ) external whenNotPaused {
        bytes32 msgHash = keccak256(
            abi.encodePacked(KEY_VERIFY_MESSAGE_PREFIX, id, newVerifiedCount, registryVersion)
        );
        _verifySignatures(msgHash, signatures);

        registry.updateVerifiedCount(id, newVerifiedCount, registryVersion);
    }

    function _verifySignatures(bytes32 msgHash, bytes memory signatures) private view {
        uint256 length = signatures.length / 65;
        require(
            quorum > 0 && length >= quorum && signatures.length % 65 == 0,
            "No safeguard quorum"
        );
        address prevSignerAddr = address(0);
        for (uint256 i = 0; i < length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signatures, i);
            address signerAddr = ECDSA.recover(msgHash, v, r, s);
            require(isSafeguard(signerAddr), "Invalid signature");
            require(signerAddr > prevSignerAddr, "Signatures not sorted");
            prevSignerAddr = signerAddr;
        }
    }

    /// @dev divides compact bytes signature {bytes32 r}{bytes32 s}{uint8 v} into `uint8 v, bytes32 r, bytes32 s`.
    ///      Make sure to peform a bounds check for @param pos, to avoid out of bounds access on @param signatures
    /// @param pos which signature to read. A prior bounds check of this parameter should be performed, to avoid out of bounds access
    /// @param signatures concatenated rsv signatures
    function _splitSignature(
        bytes memory signatures,
        uint256 pos
    ) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        assembly {
            let signaturePos := add(signatures, mul(0x41, pos))
            r := mload(add(signaturePos, 0x20))
            s := mload(add(signaturePos, 0x40))
            v := byte(0, mload(add(signaturePos, 0x60)))
        }
    }
}
