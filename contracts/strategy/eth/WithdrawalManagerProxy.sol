// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/proxy/Proxy.sol";

import "./WithdrawalManagerFactory.sol";

// An individual withdraw maanger for a node operator

contract WithdrawalManagerProxy is Proxy {
    using Address for address;

    WithdrawalManagerFactory internal immutable withdrawalManagerFactory;

    constructor(WithdrawalManagerFactory withdrawalManagerFactory_, uint256 operatorID_) public {
        // Initialize withdrawalManagerFactory
        require(address(withdrawalManagerFactory_) != address(0x0), "Invalid factory address");
        withdrawalManagerFactory = withdrawalManagerFactory_;
        // Check for contract existence
        address implAddress = withdrawalManagerFactory_.implementation();
        require(implAddress.isContract(), "Delegate contract does not exist");
        // Call Initialize on delegate
        (bool success, ) = implAddress.delegatecall(
            abi.encodeWithSignature("initialize(uint256)", operatorID_)
        );
        if (!success) {
            revert("Failed delegatecall");
        }
    }

    function _implementation() internal view override returns (address) {
        return withdrawalManagerFactory.implementation();
    }
}
