// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract FundRoles is AccessControl {
    bytes32 public constant PRIMARY_MARKET_ROLE = keccak256("primaryMarket");

    mapping(address => bool) private _shareMembers;

    constructor() internal {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function _initializeRoles(
        address tokenP_,
        address tokenA_,
        address tokenB_,
        address primaryMarket_
    ) internal {
        _shareMembers[tokenP_] = true;
        _shareMembers[tokenA_] = true;
        _shareMembers[tokenB_] = true;

        _setupRole(PRIMARY_MARKET_ROLE, primaryMarket_);
    }

    modifier onlyAdmin() {
        require(isAdmin(msg.sender), "FundRoles: only admin");
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

    modifier onlyPrimaryMarket() {
        require(isPrimaryMarket(msg.sender), "FundRoles: only primary market");
        _;
    }

    function isPrimaryMarket(address account) public view returns (bool) {
        return hasRole(PRIMARY_MARKET_ROLE, account);
    }

    function addPrimaryMarket(address account) public {
        grantRole(PRIMARY_MARKET_ROLE, account);
    }

    function removePrimaryMarket(address account) public {
        revokeRole(PRIMARY_MARKET_ROLE, account);
    }

    modifier onlyShare() {
        require(isShare(msg.sender), "FundRoles: only share");
        _;
    }

    function isShare(address account) public view returns (bool) {
        return _shareMembers[account];
    }
}
