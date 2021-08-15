// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

contract AddressWhitelist {
    address private constant AUTOFARM_STAKER = 0x588D3774CCf20E0869AC7DCF94bc7f99798C20Cd;

    function check(address account) external pure returns (bool) {
        if (account == AUTOFARM_STAKER) {
            return true;
        }
        return false;
    }
}
