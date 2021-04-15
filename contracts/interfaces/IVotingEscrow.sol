// SPDX-License-Identifier: MIT
pragma experimental ABIEncoderV2;
pragma solidity ^0.6.0;

interface IVotingEscrow {
    struct LockedBalance {
        uint256 amount;
        uint256 unlockTime;
    }

    enum LockType {
        DEPOSIT_FOR_TYPE,
        CREATE_LOCK_TYPE,
        INCREASE_LOCK_AMOUNT,
        INCREASE_UNLOCK_TIME,
        INVALID_TYPE
    }

    event Locked(
        address indexed account,
        uint256 amount,
        uint256 indexed unlockTime,
        LockType lockType
    );
    event Withdrawn(address indexed account, uint256 amount);

    function token() external view returns (address);

    function maxTime() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function balanceOfAtTimestamp(address account, uint256 timestamp)
        external
        view
        returns (uint256);

    function getTimestampDropBelow(address account, uint256 threshold)
        external
        view
        returns (uint256);

    function getLockedBalance(address account) external view returns (LockedBalance memory);
    //function burn(uint256 amount) external;
}
