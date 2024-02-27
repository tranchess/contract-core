// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "./SwapBonus.sol";

contract SwapBonusWrapper is Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    address public immutable swapBonus;
    address public immutable admin;
    address public immutable bonusToken;

    constructor(address swapBonus_, address admin_) public {
        swapBonus = swapBonus_;
        admin = admin_;
        bonusToken = SwapBonus(swapBonus_).bonusToken();
    }

    function updateBonus(uint256 amount, uint256 interval) external onlyOwner {
        uint256 realAmount = amount.div(interval).mul(interval);
        IERC20(bonusToken).safeTransferFrom(msg.sender, address(this), realAmount);
        IERC20(bonusToken).approve(swapBonus, realAmount);
        SwapBonus(swapBonus).updateBonus(amount, block.timestamp, interval);
    }

    function transferOwnershipToAdmin() external onlyOwner {
        SwapBonus(swapBonus).transferOwnership(admin);
    }
}
