// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../utils/SafeDecimalMath.sol";

contract LiquidityStaking {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    address public immutable rewardToken;
    address public immutable stakedToken;
    uint256 public immutable startTimestamp;
    uint256 public immutable endTimestamp;
    uint256 public rate;

    uint256 public lastTimestamp;
    uint256 public globalIntegral;
    uint256 public totalStakes;
    mapping(address => uint256) public integrals;
    mapping(address => uint256) public stakes;
    mapping(address => uint256) public claimableRewards;

    constructor(
        address rewardToken_,
        address stakedToken_,
        uint256 startTimestamp_,
        uint256 endTimestamp_
    ) public {
        require(startTimestamp_ >= block.timestamp, "Start cannot be in the past");
        rewardToken = rewardToken_;
        stakedToken = stakedToken_;
        startTimestamp = startTimestamp_;
        lastTimestamp = startTimestamp_;
        endTimestamp = endTimestamp_;
    }

    function initialize(uint256 rate_) external {
        require(startTimestamp >= block.timestamp, "Start cannot be in the past");

        uint256 amount = rate_.mul(endTimestamp.sub(startTimestamp));
        require(
            IERC20(rewardToken).transferFrom(msg.sender, address(this), amount),
            "TransferFrom failed"
        );

        rate = rate_;
    }

    function userCheckpoint(address account) public {
        _checkpoint();
        _rewardCheckpoint(account);
    }

    function deposit(uint256 amount) external {
        userCheckpoint(msg.sender);

        require(
            IERC20(stakedToken).transferFrom(msg.sender, address(this), amount),
            "TransferFrom failed"
        );
        totalStakes = totalStakes.add(amount);
        stakes[msg.sender] = stakes[msg.sender].add(amount);
    }

    function withdraw(uint256 amount) external {
        userCheckpoint(msg.sender);

        require(IERC20(stakedToken).transfer(msg.sender, amount), "Transfer failed");
        totalStakes = totalStakes.sub(amount, "Exceed staked balances");
        stakes[msg.sender] = stakes[msg.sender].sub(amount, "Exceed staked balances");
    }

    function claimRewards() public returns (uint256 rewards) {
        userCheckpoint(msg.sender);

        rewards = claimableRewards[msg.sender];
        require(IERC20(rewardToken).transfer(msg.sender, rewards), "Transfer failed");
        delete claimableRewards[msg.sender];
    }

    function _checkpoint() private {
        // Skip if before start timestamp
        if (block.timestamp < startTimestamp) {
            return;
        }

        uint256 nextTimestamp = endTimestamp.min(block.timestamp);
        uint256 timeLapse = nextTimestamp.sub(lastTimestamp);
        uint256 totalStakes_ = totalStakes;

        if (timeLapse != 0) {
            if (totalStakes_ != 0) {
                // calculate global integral till now
                globalIntegral = globalIntegral.add(
                    rate.mul(timeLapse).divideDecimal(totalStakes_)
                );
            }

            // update global state
            lastTimestamp = nextTimestamp;
        }
    }

    function _rewardCheckpoint(address account) private {
        // claim rewards till now
        uint256 claimableReward =
            stakes[account].multiplyDecimal(globalIntegral.sub(integrals[account]));
        claimableRewards[account] = claimableRewards[account].add(claimableReward);

        // update per-user state
        integrals[account] = globalIntegral;
    }
}
