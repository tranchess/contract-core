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

    constructor(address[] memory handles_) public {
        uint256 count = handles_.length;
        for (uint256 i = 0; i < count; i++) {
            _addCallbackHandle(handles_[i]);
        }
    }

    function addCallbackHandle(address callbackHandle) external onlyOwner {
        _addCallbackHandle(callbackHandle);
    }

    function _addCallbackHandle(address callbackHandle) private {
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
