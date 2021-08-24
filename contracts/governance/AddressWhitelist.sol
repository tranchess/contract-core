// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

contract AddressWhitelist {
    mapping(address => bool) public whitelist;

    constructor(address[] memory whitelistAccounts) public {
        for (uint256 i = 0; i < whitelistAccounts.length; i++) {
            whitelist[whitelistAccounts[i]] = true;
        }
    }

    function check(address account) external view returns (bool) {
        return whitelist[account];
    }
}
