// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../exchange/Staking.sol";

contract StakingTestWrapper is Staking {
    constructor(
        address fund_,
        address chessSchedule_,
        address chessController_,
        address quoteAssetAddress_,
        uint256 guardedLaunchStart_
    )
        public
        Staking(fund_, chessSchedule_, chessController_, quoteAssetAddress_, guardedLaunchStart_)
    {}

    function tradeAvailable(
        uint256 tranche,
        address sender,
        uint256 amount
    ) external {
        _tradeAvailable(tranche, sender, amount);
    }

    function rebalanceAndClearTrade(
        address account,
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 amountVersion
    ) external {
        _rebalanceAndClearTrade(account, amountM, amountA, amountB, amountVersion);
    }

    function lock(
        uint256 tranche,
        address account,
        uint256 amount
    ) external {
        _lock(tranche, account, amount);
    }

    function rebalanceAndUnlock(
        address account,
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 amountVersion
    ) external {
        _rebalanceAndUnlock(account, amountM, amountA, amountB, amountVersion);
    }

    function tradeLocked(
        uint256 tranche,
        address account,
        uint256 amount
    ) external {
        _tradeLocked(tranche, account, amount);
    }
}
