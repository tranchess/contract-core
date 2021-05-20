// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/utils/EnumerableSet.sol";

abstract contract ChessRoles {
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet private _minterMembers;

    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);

    modifier onlyMinter() {
        require(isMinter(msg.sender), "Only minter");
        _;
    }

    function isMinter(address account) public view returns (bool) {
        return _minterMembers.contains(account);
    }

    function getMinterMember(uint256 index) external view returns (address) {
        return _minterMembers.at(index);
    }

    function getMinterCount() external view returns (uint256) {
        return _minterMembers.length();
    }

    function _addMinter(address minter) internal {
        if (_minterMembers.add(minter)) {
            emit MinterAdded(minter);
        }
    }

    function _removeMinter(address minter) internal {
        if (_minterMembers.remove(minter)) {
            emit MinterRemoved(minter);
        }
    }
}
