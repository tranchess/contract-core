// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IAprOracle.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../fund/ShareStaking.sol";

// Issue: The ShareStaking contract's _checkpoint() function had a vulnerability where
// it could be skipped if invoked multiple times in the same block, potentially leading to
// discrepancies between total supplies and actual balances after a rebalance event. This
// could be exploited by an attacker through a series of transactions involving
// frontrunning the rebalance call, thus draining user funds by manipulating the spareAmount.

// Fix: This new BscAprOracleProxy contract has been introduced to wrap around the existing
// BscAprOracle. It checks for fund version changes on every capture() call. If a change is
// detected, it deliberately interacts with the ShareStaking contract to expose the potential
// vulnerability by comparing total supplies before and after. Any mismatch triggers a revert,
// preventing the checkpoint bypass and ensuring the rebalance can only happen if _checkpoint()
// is properly called and updated in the same block as Fund.settle().

// The fix is implemented as an external proxy to the immutable Fund contract to avoid the need
// for updating the ShareStaking contract itself, thus maintaining the integrity of the protocol
// and safeguarding user funds.

// Known Issue: The fix could be used to delay rebalance, but it is not economically viable for
// an attacker to do so over a prolonged period, as the costs would quickly outweigh the potential
// benefits, which is basically next to zero.

contract BscAprOracleProxy is IAprOracle, ITrancheIndexV2 {
    // Under extreme circumstances, there might not be enough amount of token to deposit;
    // we could always transfer more QUEEN to resolve the issue.
    uint256 public constant DEPOSIT_AMOUNT = 1e15;
    IAprOracle public immutable aprOracle;
    IFundV3 public immutable fund;
    ShareStaking public immutable shareStaking;

    uint256 public currentVersion;

    constructor(IAprOracle aprOracle_, IFundV3 fund_, ShareStaking shareStaking_) public {
        aprOracle = aprOracle_;
        fund = fund_;
        shareStaking = shareStaking_;
        currentVersion = fund_.getRebalanceSize();
        _approveMax(fund_, address(shareStaking_));
    }

    function capture() external override returns (uint256 dailyRate) {
        uint256 newVersion = fund.getRebalanceSize();
        if (newVersion != currentVersion) {
            uint256 amountQ = fund.trancheBalanceOf(TRANCHE_Q, address(this));
            if (amountQ > 0) {
                IPrimaryMarketV3 primaryMarket = IPrimaryMarketV3(fund.primaryMarket());
                primaryMarket.split(address(this), amountQ, newVersion);
                _approveMax(fund, address(shareStaking));
            }
            currentVersion = newVersion;
            uint256 oldStakingQ = shareStaking.totalSupply(TRANCHE_Q);
            shareStaking.deposit(TRANCHE_B, DEPOSIT_AMOUNT, address(this), newVersion);
            shareStaking.deposit(TRANCHE_R, DEPOSIT_AMOUNT, address(this), newVersion);
            uint256 newStakingQ = shareStaking.totalSupply(TRANCHE_Q);
            require(newStakingQ == oldStakingQ, "Rebalance check failed");
            shareStaking.withdraw(TRANCHE_B, DEPOSIT_AMOUNT, newVersion);
            shareStaking.withdraw(TRANCHE_R, DEPOSIT_AMOUNT, newVersion);
        }
        return aprOracle.capture();
    }

    function _approveMax(IFundV3 fund_, address spender) private {
        // Approve max BISHOP and ROOK to ShareStaking
        fund_.trancheApprove(TRANCHE_B, spender, type(uint256).max, fund_.getRebalanceSize());
        fund_.trancheApprove(TRANCHE_R, spender, type(uint256).max, fund_.getRebalanceSize());
    }
}
