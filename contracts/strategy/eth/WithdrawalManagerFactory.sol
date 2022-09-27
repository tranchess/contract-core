// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "./WithdrawalManagerProxy.sol";

contract WithdrawalManagerFactory is Ownable {
    using SafeMath for uint256;

    event ImplementationUpdateProposed(
        address indexed newImplementation,
        uint256 minTimestamp,
        uint256 maxTimestamp
    );
    event ImplementationUpdated(
        address indexed previousImplementation,
        address indexed newImplementation
    );

    uint256 private constant ROLE_UPDATE_MIN_DELAY = 3 days;
    uint256 private constant ROLE_UPDATE_MAX_DELAY = 15 days;

    address public immutable registry;

    address public implementation;
    address internal _proposedImplementation;
    uint256 internal _proposedImplementationTimestamp;

    constructor(address registry_) public {
        registry = registry_;
    }

    function deployContract(uint256 id) external onlyRegistry returns (address) {
        WithdrawalManagerProxy proxy = new WithdrawalManagerProxy(this, id);
        return address(proxy);
    }

    function proposeImplementationUpdate(address newImplementation) external onlyOwner {
        require(newImplementation != implementation);
        _proposedImplementation = newImplementation;
        _proposedImplementationTimestamp = block.timestamp;
        emit ImplementationUpdateProposed(
            newImplementation,
            block.timestamp + ROLE_UPDATE_MIN_DELAY,
            block.timestamp + ROLE_UPDATE_MAX_DELAY
        );
    }

    function applyImplementationUpdate(address newImplementation) external onlyOwner {
        require(_proposedImplementation == newImplementation, "Proposed address mismatch");
        require(
            block.timestamp >= _proposedImplementationTimestamp + ROLE_UPDATE_MIN_DELAY &&
                block.timestamp < _proposedImplementationTimestamp + ROLE_UPDATE_MAX_DELAY,
            "Not ready to update"
        );
        emit ImplementationUpdated(implementation, newImplementation);
        implementation = newImplementation;
        _proposedImplementation = address(0);
        _proposedImplementationTimestamp = 0;
    }

    modifier onlyRegistry() {
        require(msg.sender == registry, "Only registry");
        _;
    }
}
