// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "./RewardClaimer.sol";

interface IBribeVault {
    function BRIBE_VAULT() external view returns (address);

    function depositBribeERC20(
        bytes32 proposal,
        address token,
        uint256 amount
    ) external;
}

contract Briber is Ownable {
    using SafeERC20 for IERC20;

    IBribeVault public immutable bribeVault;
    RewardClaimer public immutable rewardClaimer;
    address public immutable token;

    constructor(
        address bribeVault_,
        address rewardClaimer_,
        address token_
    ) public {
        bribeVault = IBribeVault(bribeVault_);
        rewardClaimer = RewardClaimer(rewardClaimer_);
        token = token_;
    }

    function bribe(uint256 proposalIndex, uint256 choiceIndex) external onlyOwner {
        bytes32 proposal = keccak256(abi.encodePacked(proposalIndex, choiceIndex));
        rewardClaimer.claimRewards();
        uint256 bribeAmount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeApprove(bribeVault.BRIBE_VAULT(), bribeAmount);
        bribeVault.depositBribeERC20(proposal, token, bribeAmount);
    }
}
