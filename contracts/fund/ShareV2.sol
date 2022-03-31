// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IFundV3.sol";
import "../interfaces/IShareV2.sol";

contract ShareV2 is IShareV2 {
    uint8 public constant decimals = 18;
    IFundV3 public immutable fund;
    uint256 public immutable tranche;

    string public name;
    string public symbol;

    constructor(
        string memory name_,
        string memory symbol_,
        address fund_,
        uint256 tranche_
    ) public {
        name = name_;
        symbol = symbol_;
        fund = IFundV3(fund_);
        tranche = tranche_;
    }

    function totalSupply() external view override returns (uint256) {
        return fund.trancheTotalSupply(tranche);
    }

    function balanceOf(address account) external view override returns (uint256) {
        return fund.trancheBalanceOf(tranche, account);
    }

    function transfer(address recipient, uint256 amount) external override returns (bool) {
        fund.shareTransfer(msg.sender, recipient, amount);
        return true;
    }

    function allowance(address owner, address spender) external view override returns (uint256) {
        return fund.trancheAllowance(tranche, owner, spender);
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        fund.shareApprove(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external override returns (bool) {
        fund.shareTransferFrom(msg.sender, sender, recipient, amount);
        return true;
    }

    function increaseAllowance(address spender, uint256 addedValue) external returns (bool) {
        fund.shareIncreaseAllowance(msg.sender, spender, addedValue);
        return true;
    }

    function decreaseAllowance(address spender, uint256 subtractedValue) external returns (bool) {
        fund.shareDecreaseAllowance(msg.sender, spender, subtractedValue);
        return true;
    }

    modifier onlyFund() {
        require(msg.sender == address(fund), "Only fund");
        _;
    }

    function fundEmitTransfer(
        address sender,
        address recipient,
        uint256 amount
    ) external override onlyFund {
        emit Transfer(sender, recipient, amount);
    }

    function fundEmitApproval(
        address owner,
        address spender,
        uint256 amount
    ) external override onlyFund {
        emit Approval(owner, spender, amount);
    }
}
