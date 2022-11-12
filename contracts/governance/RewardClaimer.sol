// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/IChessSchedule.sol";
import "../interfaces/IChessController.sol";
import "../utils/CoreUtility.sol";

contract RewardClaimer is Ownable, CoreUtility {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    event ClaimerUpdated(address newClaimer);

    uint256 private constant MAX_ITERATIONS = 500;

    IChessSchedule public immutable chessSchedule;
    IChessController public immutable chessController;

    address public rewardClaimer;
    uint256 public claimableChess;

    uint256 private _chessIntegral;
    uint256 private _chessIntegralTimestamp;
    uint256 private _rate;

    constructor(address chessSchedule_, address chessController_) public {
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
    }

    function checkpoint() external returns (uint256 amount) {
        amount = claimableChess;
        uint256 delta = _checkpoint();
        if (delta != 0) {
            amount = amount.add(delta);
            claimableChess = amount;
        }
    }

    function updateClaimer(address newClaimer) external onlyOwner {
        rewardClaimer = newClaimer;
        emit ClaimerUpdated(newClaimer);
    }

    modifier onlyClaimer() {
        require(msg.sender == rewardClaimer, "Only reward claimer");
        _;
    }

    function claimRewards(uint256 amount) external onlyClaimer {
        claimableChess = claimableChess.add(_checkpoint()).sub(amount);
        chessSchedule.mint(msg.sender, amount);
    }

    function _checkpoint() private returns (uint256 amount) {
        uint256 timestamp = _chessIntegralTimestamp;
        uint256 integral = _chessIntegral;
        uint256 oldIntegral = integral;
        uint256 endWeek = _endOfWeek(timestamp);
        uint256 rate = _rate;
        if (rate == 0) {
            // CHESS emission may update in the middle of a week due to cross-chain lag.
            // We re-calculate the rate if it was zero after the last checkpoint.
            uint256 weeklySupply = chessSchedule.getWeeklySupply(timestamp);
            if (weeklySupply != 0) {
                rate = (weeklySupply / (endWeek - timestamp)).mul(
                    chessController.getFundRelativeWeight(address(this), timestamp)
                );
            }
        }

        for (uint256 i = 0; i < MAX_ITERATIONS && timestamp < block.timestamp; i++) {
            uint256 endTimestamp = endWeek.min(block.timestamp);
            integral = integral.add(rate.mul(endTimestamp - timestamp));
            if (endTimestamp == endWeek) {
                rate = chessSchedule.getRate(endWeek).mul(
                    chessController.getFundRelativeWeight(address(this), endWeek)
                );
                endWeek += 1 weeks;
            }
            timestamp = endTimestamp;
        }

        // Update global state
        _chessIntegralTimestamp = block.timestamp;
        _chessIntegral = integral;
        _rate = rate;

        amount = integral.sub(oldIntegral);
    }
}
