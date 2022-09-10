// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

abstract contract ProxyUtility {
    /// @dev Storage slot with the admin of the contract.
    bytes32 private constant _ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);

    /// @dev Revert if the proxy admin is not the caller
    modifier onlyProxyAdmin() {
        bytes32 slot = _ADMIN_SLOT;
        address proxyAdmin;
        assembly {
            proxyAdmin := sload(slot)
        }
        require(msg.sender == proxyAdmin, "Only proxy admin");
        _;
    }
}
