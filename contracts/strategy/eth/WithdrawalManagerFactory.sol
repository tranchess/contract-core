// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./WithdrawalManagerProxy.sol";

contract WithdrawalManagerFactory is Ownable {
    event ImplementationUpdated(address indexed newImplementation);

    address public implementation;

    constructor(address implementation_) public {
        _updateImplementation(implementation_);
    }

    function deployContract(uint256 id) external returns (address) {
        WithdrawalManagerProxy proxy = new WithdrawalManagerProxy(this, id);
        return address(proxy);
    }

    function updateImplementation(address newImplementation) external onlyOwner {
        _updateImplementation(newImplementation);
    }

    function _updateImplementation(address newImplementation) private {
        implementation = newImplementation;
        emit ImplementationUpdated(newImplementation);
    }
}
