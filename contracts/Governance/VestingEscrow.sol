// SPDX-License-Identifier: MIT
pragma solidity 0.6.9;

/// @title Simple Vesting Escrow
/// @author Curve Finance
/// @license MIT
/// @notice Vests `ERC20CRV` tokens for a single address
/// @dev Intended to be deployed many times via `VotingEscrowFactory`

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract VestingEscrow is Ownable, ReentrancyGuard {
    using SafeMath for uint256;

    event Fund(address indexed recipient, uint256 amount);
    event Claim(address indexed recipient, uint256 claimed);

    event ToggleDisable(address recipient, bool disabled);

    address public token;
    uint256 public startTime;
    uint256 public endTime;
    mapping(address => uint256) public initialLocked;
    mapping(address => uint256) public totalClaimed;

    uint256 public initialLockedSupply;

    bool public canDisable;
    mapping(address => uint256) public disabledAt;

    function initialize(
        address _token,
        address _recipient,
        uint256 _amount,
        uint256 _startTime,
        uint256 _endTime,
        bool _canDisable
    ) external {
        require(endTime == 0, "Already initialized");

        token = _token;
        startTime = _startTime;
        endTime = _endTime;
        canDisable = _canDisable;

        IERC20(_token).transferFrom(msg.sender, address(this), _amount);

        initialLocked[_recipient] = _amount;
        initialLockedSupply = _amount;
        emit Fund(_recipient, _amount);
    }

    /// @notice Get the total number of tokens which have vested, that are held
    ///         by this contract
    function vestedSupply() external view returns (uint256) {
        return _totalVested();
    }

    /// @notice Get the total number of tokens which are still locked
    ///         (have not yet vested)
    function lockedSupply() external view returns (uint256) {
        return initialLockedSupply.sub(_totalVested());
    }

    /// @notice Get the number of tokens which have vested for a given address
    /// @param recipient address to check
    function vestedOf(address recipient) external view returns (uint256) {
        return _totalVestedOf(recipient, block.timestamp);
    }

    /// @notice Get the number of unclaimed, vested tokens for a given address
    /// @param recipient address to check
    function balanceOf(address recipient) external view returns (uint256) {
        return _totalVestedOf(recipient, block.timestamp).sub(totalClaimed[recipient]);
    }

    /// @notice Get the number of locked tokens for a given address
    /// @param recipient address to check
    function lockedOf(address recipient) external view returns (uint256) {
        return initialLocked[recipient].sub(_totalVestedOf(recipient, block.timestamp));
    }

    /// @notice Disable or re-enable a vested address's ability to claim tokens
    /// @dev When disabled, the address is only unable to claim tokens which are still
    ///      locked at the time of this call. It is not possible to block the claim
    ///      of tokens which have already vested.
    /// @param recipient Address to disable or enable
    function toggleDisable(address recipient) external onlyOwner {
        require(canDisable, "Cannot disable");

        bool isDisabled = disabledAt[recipient] == 0;
        if (isDisabled) {
            disabledAt[recipient] = block.timestamp;
        } else {
            disabledAt[recipient] = 0;
        }

        emit ToggleDisable(recipient, isDisabled);
    }

    /// @notice Disable the ability to call `toggleDisable`
    function disableCanDisable() external onlyOwner {
        canDisable = false;
    }

    /// @notice Claim tokens which have vested
    /// @param recipient Address to claim tokens for
    function claim(address recipient) external nonReentrant {
        uint256 timestamp = disabledAt[recipient];
        if (timestamp == 0) {
            timestamp = block.timestamp;
        }
        uint256 claimable = _totalVestedOf(recipient, timestamp).sub(totalClaimed[recipient]);
        totalClaimed[recipient] = totalClaimed[recipient].add(claimable);
        IERC20(token).transfer(recipient, claimable);

        emit Claim(recipient, claimable);
    }

    function _totalVestedOf(address recipient, uint256 timestamp) internal view returns (uint256) {
        uint256 start = startTime;
        uint256 end = endTime;
        uint256 locked = initialLocked[recipient];
        if (timestamp < start) {
            return 0;
        }
        return Math.min((locked.mul(timestamp.sub(start))).div(end.sub(start)), locked);
    }

    function _totalVested() internal view returns (uint256) {
        uint256 start = startTime;
        uint256 end = endTime;
        uint256 locked = initialLockedSupply;
        if (block.timestamp < start) {
            return 0;
        }
        return Math.min((locked.mul(block.timestamp.sub(start))).div(end.sub(start)), locked);
    }
}
