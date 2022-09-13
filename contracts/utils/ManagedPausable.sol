// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.0 <0.8.0;

/**
 * @dev Contract of an emergency stop mechanism that can be triggered by an authorized account.
 *
 * This module is modified based on Pausable in OpenZeppelin v3.3.0, adding public functions to
 * pause, unpause and manage the pauser role. It is also designed to be used by upgradable
 * contracts, like PausableUpgradable but with compact storage slots and no dependencies.
 */
abstract contract ManagedPausable {
    /**
     * @dev Emitted when the pause is triggered by `account`.
     */
    event Paused(address account);

    /**
     * @dev Emitted when the pause is lifted by `account`.
     */
    event Unpaused(address account);

    event PauserRoleTransferred(address indexed previousPauser, address indexed newPauser);

    uint256 private constant FALSE = 0;
    uint256 private constant TRUE = 1;

    uint256 private _initialized;

    uint256 private _paused;

    address private _pauser;

    function _initializeManagedPausable(address pauser_) internal {
        require(_initialized == FALSE);
        _initialized = TRUE;
        _paused = FALSE;
        _pauser = pauser_;
    }

    /**
     * @dev Returns true if the contract is paused, and false otherwise.
     */
    function paused() public view returns (bool) {
        return _paused != FALSE;
    }

    function pauser() public view returns (address) {
        return _pauser;
    }

    function renouncePauserRole() external onlyPauser {
        emit PauserRoleTransferred(_pauser, address(0));
        _pauser = address(0);
    }

    function transferPauserRole(address newPauser) external onlyPauser {
        require(newPauser != address(0));
        emit PauserRoleTransferred(_pauser, newPauser);
        _pauser = newPauser;
    }

    modifier onlyPauser() {
        require(_pauser == msg.sender, "Pausable: only pauser");
        _;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is not paused.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     */
    modifier whenNotPaused() {
        require(_paused == FALSE, "Pausable: paused");
        _;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is paused.
     *
     * Requirements:
     *
     * - The contract must be paused.
     */
    modifier whenPaused() {
        require(_paused != FALSE, "Pausable: not paused");
        _;
    }

    /**
     * @dev Triggers stopped state.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     */
    function pause() external onlyPauser whenNotPaused {
        _paused = TRUE;
        emit Paused(msg.sender);
    }

    /**
     * @dev Returns to normal state.
     *
     * Requirements:
     *
     * - The contract must be paused.
     */
    function unpause() external onlyPauser whenPaused {
        _paused = FALSE;
        emit Unpaused(msg.sender);
    }
}
