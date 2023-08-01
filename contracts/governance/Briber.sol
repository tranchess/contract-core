// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "./RewardClaimer.sol";

interface IBribeMarket {
    function BRIBE_VAULT() external view returns (address);

    function depositBribe(
        bytes32 proposal,
        address token,
        uint256 amount,
        uint256 maxTokensPerVote,
        uint256 periods
    ) external;
}

contract Briber is Ownable {
    using SafeERC20 for IERC20;

    // Hidden hands ve2 config
    uint256 public constant NO_MAX_TOKENS_PER_VOTE = 0; // No limit
    uint256 public constant ONE_PERIOD = 1; // 1 round

    IBribeMarket public immutable bribeMarket;
    RewardClaimer public immutable rewardClaimer;
    address public immutable token;

    constructor(address bribeMarket_, address rewardClaimer_, address token_) public {
        bribeMarket = IBribeMarket(bribeMarket_);
        rewardClaimer = RewardClaimer(rewardClaimer_);
        token = token_;
    }

    function bribe(uint256 proposalIndex, uint256 choiceIndex) external onlyOwner {
        bytes32 proposal = keccak256(abi.encodePacked(proposalIndex, choiceIndex));
        rewardClaimer.claimRewards();
        uint256 bribeAmount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeApprove(bribeMarket.BRIBE_VAULT(), bribeAmount);
        bribeMarket.depositBribe(proposal, token, bribeAmount, NO_MAX_TOKENS_PER_VOTE, ONE_PERIOD);
    }
}
