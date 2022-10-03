// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "../interfaces/IVotingEscrow.sol";

contract VotingEscrowCallback is IVotingEscrowCallback, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    event CallbackHandleAdded(address callbackHandle);
    event CallbackHandleRemoved(address callbackHandle);

    EnumerableSet.AddressSet private _handles;

    function getCallbackHandles() external view returns (address[] memory handles) {
        uint256 length = _handles.length();
        handles = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            handles[i] = _handles.at(i);
        }
    }

    function addCallbackHandle(address callbackHandle) external onlyOwner {
        if (_handles.add(callbackHandle)) {
            emit CallbackHandleAdded(callbackHandle);
        }
    }

    function removeCallbackHandle(address callbackHandle) external onlyOwner {
        if (_handles.remove(callbackHandle)) {
            emit CallbackHandleRemoved(callbackHandle);
        }
    }

    function syncWithVotingEscrow(address account) external override {
        uint256 count = _handles.length();
        for (uint256 i = 0; i < count; i++) {
            IVotingEscrowCallback(_handles.at(i)).syncWithVotingEscrow(account);
        }
    }
}
