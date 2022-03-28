// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

contract SwapReward is Ownable {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    address public swap;
    address public rewardToken;
    uint256 public ratePerSecond;
    uint256 public startTimestamp;
    uint256 public endTimestamp;
    uint256 public lastTimestamp;

    function updateReward(
        address caller,
        address token,
        uint256 amount,
        uint256 start,
        uint256 interval
    ) external onlyOwner {
        require(
            endTimestamp < block.timestamp && endTimestamp == lastTimestamp,
            "Last reward not yet expired"
        );
        require(caller != address(0));
        swap = caller;
        rewardToken = token;
        ratePerSecond = amount.div(interval);
        startTimestamp = start.max(block.timestamp);
        endTimestamp = start.add(interval);
        lastTimestamp = startTimestamp;
        IERC20(rewardToken).safeTransferFrom(
            msg.sender,
            address(this),
            ratePerSecond.mul(interval)
        );
    }

    function getReward() external {
        require(msg.sender == swap);
        uint256 currentTimestamp = endTimestamp.min(block.timestamp);
        uint256 reward = ratePerSecond.mul(currentTimestamp - lastTimestamp);
        lastTimestamp = currentTimestamp;
        if (reward > 0) {
            IERC20(rewardToken).safeTransfer(swap, reward);
        }
    }
}
