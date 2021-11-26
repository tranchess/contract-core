// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/utils/EnumerableSet.sol";

abstract contract FundRoles {
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet private _primaryMarketMembers;
    mapping(address => bool) private _shareMembers;

    event PrimaryMarketAdded(address indexed primaryMarket);
    event PrimaryMarketRemoved(address indexed primaryMarket);

    function _initializeRoles(
        address tokenM_,
        address tokenA_,
        address tokenB_,
        address primaryMarket_
    ) internal {
        _shareMembers[tokenM_] = true;
        _shareMembers[tokenA_] = true;
        _shareMembers[tokenB_] = true;

        _addPrimaryMarket(primaryMarket_);
    }

    modifier onlyPrimaryMarket() {
        require(isPrimaryMarket(msg.sender), "FundRoles: only primary market");
        _;
    }

    function isPrimaryMarket(address account) public view returns (bool) {
        return _primaryMarketMembers.contains(account);
    }

    function getPrimaryMarketMember(uint256 index) public view returns (address) {
        return _primaryMarketMembers.at(index);
    }

    function getPrimaryMarketCount() public view returns (uint256) {
        return _primaryMarketMembers.length();
    }

    function _addPrimaryMarket(address primaryMarket) internal {
        if (_primaryMarketMembers.add(primaryMarket)) {
            emit PrimaryMarketAdded(primaryMarket);
        }
    }

    function _removePrimaryMarket(address primaryMarket) internal {
        if (_primaryMarketMembers.remove(primaryMarket)) {
            emit PrimaryMarketRemoved(primaryMarket);
        }
    }

    modifier onlyShare() {
        require(isShare(msg.sender), "FundRoles: only share");
        _;
    }

    function isShare(address account) public view returns (bool) {
        return _shareMembers[account];
    }
}
