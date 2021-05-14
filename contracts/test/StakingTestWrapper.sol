// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../exchange/Staking.sol";

contract StakingTestWrapper is Staking {
    constructor(
        address fund_,
        address chess_,
        address chessController_,
        address quoteAssetAddress_
    ) public Staking(fund_, chess_, chessController_, quoteAssetAddress_) {}

    function tradeAvailable(
        uint256 tranche,
        address sender,
        uint256 amount
    ) external {
        _tradeAvailable(tranche, sender, amount);
    }

    function convertAndClearTrade(
        address account,
        uint256 amountP,
        uint256 amountA,
        uint256 amountB,
        uint256 amountVersion
    ) external {
        _convertAndClearTrade(account, amountP, amountA, amountB, amountVersion);
    }

    function lock(
        uint256 tranche,
        address account,
        uint256 amount
    ) external {
        _lock(tranche, account, amount);
    }

    function convertAndUnlock(
        address account,
        uint256 amountP,
        uint256 amountA,
        uint256 amountB,
        uint256 amountVersion
    ) external {
        _convertAndUnlock(account, amountP, amountA, amountB, amountVersion);
    }

    function tradeLocked(
        uint256 tranche,
        address account,
        uint256 amount
    ) external {
        _tradeLocked(tranche, account, amount);
    }
}
