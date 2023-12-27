// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../interfaces/IWstETH.sol";

import "../utils/SafeDecimalMath.sol";

contract MockWstETH is IWstETH, ERC20 {
    using SafeDecimalMath for uint256;

    address public immutable override stETH;

    uint256 public override stEthPerToken;

    constructor(address stETH_) public ERC20("Mock wstETH", "wstETH") {
        stETH = stETH_;
        _setupDecimals(18);
    }

    function update(uint256 rate) external {
        stEthPerToken = rate;
    }

    function getWstETHByStETH(uint256 _stETHAmount) public view override returns (uint256) {
        return _stETHAmount.divideDecimal(stEthPerToken);
    }

    function getStETHByWstETH(uint256 _wstETHAmount) public view override returns (uint256) {
        return _wstETHAmount.multiplyDecimal(stEthPerToken);
    }

    function wrap(uint256 _stETHAmount) external override returns (uint256) {
        require(_stETHAmount > 0, "wstETH: can't wrap zero stETH");
        uint256 wstETHAmount = getWstETHByStETH(_stETHAmount);
        _mint(msg.sender, wstETHAmount);
        IERC20(stETH).transferFrom(msg.sender, address(this), _stETHAmount);
        return wstETHAmount;
    }

    function unwrap(uint256 _wstETHAmount) external override returns (uint256) {
        require(_wstETHAmount > 0, "wstETH: zero amount unwrap not allowed");
        uint256 stETHAmount = getStETHByWstETH(_wstETHAmount);
        _burn(msg.sender, _wstETHAmount);
        IERC20(stETH).transfer(msg.sender, stETHAmount);
        return stETHAmount;
    }
}
