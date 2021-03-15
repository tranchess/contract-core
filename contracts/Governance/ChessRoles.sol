// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ChessRoles is AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("minter");

    constructor() internal {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    //---------- Admin ---------//
    modifier onlyAdmin() {
        require(isAdmin(msg.sender), "AdminRole: caller does not have the Admin role");
        _;
    }

    function isAdmin(address account) public view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    function addAdmin(address account) public {
        grantRole(DEFAULT_ADMIN_ROLE, account);
    }

    function renounceAdmin() public {
        renounceRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    //---------- Minter ---------//
    modifier onlyMinter() {
        require(isMinter(msg.sender), "only minter");
        _;
    }

    function isMinter(address account) public view returns (bool) {
        return hasRole(MINTER_ROLE, account);
    }

    function addMinter(address account) public {
        grantRole(MINTER_ROLE, account);
    }

    function removeMinter(address account) public {
        revokeRole(MINTER_ROLE, account);
    }
}
