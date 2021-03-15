// SPDX-License-Identifier: MIT
pragma solidity 0.6.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "./interfaces/IFund.sol";

contract Share is IERC20 {
    using SafeMath for uint256;

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 private immutable _tranche;

    IFund public fund;

    /**
     * @dev Sets the values for {name} and {symbol}, initializes {decimals} with
     * a default value of 18.
     *
     * To select a different value for {decimals}, use {_setupDecimals}.
     *
     * All three of these values are immutable: they can only be set once during
     * construction.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        address fund_,
        uint256 tranche_
    ) public {
        name = name_;
        symbol = symbol_;
        decimals = 18;
        fund = IFund(fund_);
        _tranche = tranche_;
    }

    /**
     * @dev See {IERC20-totalSupply}.
     */
    function totalSupply() public view override returns (uint256) {
        return fund.shareTotalSupply(_tranche);
    }

    /**
     * @dev See {IERC20-balanceOf}.
     */
    function balanceOf(address account) public view virtual override returns (uint256) {
        return fund.shareBalanceOf(_tranche, account);
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `recipient` cannot be the zero address.
     * - the caller must have a balance of at least `amount`.
     */
    function transfer(address recipient, uint256 amount) public virtual override returns (bool) {
        fund.transfer(_tranche, msg.sender, recipient, amount);
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }

    /**
     * @dev See {IERC20-allowance}.
     */
    function allowance(address owner, address spender)
        public
        view
        virtual
        override
        returns (uint256)
    {
        return fund.shareAllowance(_tranche, owner, spender);
    }

    /**
     * @dev See {IERC20-approve}.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function approve(address spender, uint256 amount) public virtual override returns (bool) {
        fund.approve(_tranche, msg.sender, spender, amount);
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @dev See {IERC20-transferFrom}.
     *
     * Emits an {Approval} event indicating the updated allowance. This is not
     * required by the EIP. See the note at the beginning of {ERC20}.
     *
     * Requirements:
     *
     * - `sender` and `recipient` cannot be the zero address.
     * - `sender` must have a balance of at least `amount`.
     * - the caller must have allowance for ``sender``'s tokens of at least
     * `amount`.
     */
    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) public virtual override returns (bool) {
        uint256 allowances = fund.shareAllowance(_tranche, sender, msg.sender);
        fund.approve(
            _tranche,
            sender,
            msg.sender,
            allowances.sub(amount, "ERC20: transfer amount exceeds allowance")
        );
        fund.transfer(_tranche, sender, recipient, amount);
        emit Transfer(sender, recipient, amount);
        return true;
    }

    /**
     * @dev Atomically increases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function increaseAllowance(address spender, uint256 addedValue) public virtual returns (bool) {
        uint256 allowances = allowance(msg.sender, spender);
        fund.approve(_tranche, msg.sender, spender, allowances.add(addedValue));
        emit Approval(msg.sender, spender, allowances.add(addedValue));
        return true;
    }

    /**
     * @dev Atomically decreases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     * - `spender` must have allowance for the caller of at least
     * `subtractedValue`.
     */
    function decreaseAllowance(address spender, uint256 subtractedValue)
        public
        virtual
        returns (bool)
    {
        uint256 allowances = allowance(msg.sender, spender);
        fund.approve(
            _tranche,
            msg.sender,
            spender,
            allowances.sub(subtractedValue, "ERC20: decreased allowance below zero")
        );
        emit Approval(msg.sender, spender, allowances.sub(subtractedValue));
        return true;
    }
}
