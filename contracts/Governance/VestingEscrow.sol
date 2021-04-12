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

    address public immutable token;
    uint256 public immutable startTime;
    uint256 public immutable endTime;
    address public immutable recipient;

    uint256 public initialLocked;
    uint256 public initialLockedSupply;
    uint256 public totalClaimed;

    bool public canDisable;
    uint256 public disabledAt;

    constructor(
        address token_,
        address recipient_,
        uint256 startTime_,
        uint256 endTime_,
        bool canDisable_
    ) public {
        token = token_;
        startTime = startTime_;
        endTime = endTime_;
        canDisable = canDisable_;
        recipient = recipient_;
    }

    function initialize(uint256 amount_) external {
        require(amount_ != 0, "Zero amount");
        require(initialLocked == 0, "Already initialized");

        IERC20(token).transferFrom(msg.sender, address(this), amount_);

        initialLocked = amount_;
        initialLockedSupply = amount_;
        emit Fund(recipient, amount_);
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
    function vestedOf() external view returns (uint256) {
        return _totalVestedOf(block.timestamp);
    }

    /// @notice Get the number of unclaimed, vested tokens for a given address
    /// @param account address to check
    function balanceOf(address account) external view returns (uint256) {
        if (account != recipient) {
            return 0;
        }
        return _totalVestedOf(block.timestamp).sub(totalClaimed);
    }

    /// @notice Get the number of locked tokens for a given address
    function lockedOf() external view returns (uint256) {
        return initialLocked.sub(_totalVestedOf(block.timestamp));
    }

    /// @notice Disable or re-enable a vested address's ability to claim tokens
    /// @dev When disabled, the address is only unable to claim tokens which are still
    ///      locked at the time of this call. It is not possible to block the claim
    ///      of tokens which have already vested.
    function toggleDisable() external onlyOwner {
        require(canDisable, "Cannot disable");

        bool isDisabled = disabledAt == 0;
        if (isDisabled) {
            disabledAt = block.timestamp;
        } else {
            disabledAt = 0;
        }

        emit ToggleDisable(recipient, isDisabled);
    }

    /// @notice Disable the ability to call `toggleDisable`
    function disableCanDisable() external onlyOwner {
        canDisable = false;
    }

    /// @notice Claim tokens which have vested
    function claim() external nonReentrant {
        uint256 timestamp = disabledAt;
        if (timestamp == 0) {
            timestamp = block.timestamp;
        }
        uint256 claimable = _totalVestedOf(timestamp).sub(totalClaimed);
        totalClaimed = totalClaimed.add(claimable);
        IERC20(token).transfer(recipient, claimable);

        emit Claim(recipient, claimable);
    }

    function _totalVestedOf(uint256 timestamp) internal view returns (uint256) {
        uint256 start = startTime;
        uint256 end = endTime;
        uint256 locked = initialLocked;
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
