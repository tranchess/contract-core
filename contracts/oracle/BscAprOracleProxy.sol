// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IAprOracle.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../fund/ShareStaking.sol";

contract BscAprOracleProxy is IAprOracle, ITrancheIndexV2 {
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

        // Approve max BISHOP and ROOK to ShareStaking
        fund_.trancheApprove(
            TRANCHE_B,
            address(shareStaking_),
            type(uint256).max,
            fund_.getRebalanceSize()
        );
        fund_.trancheApprove(
            TRANCHE_R,
            address(shareStaking_),
            type(uint256).max,
            fund_.getRebalanceSize()
        );
    }

    function capture() external override returns (uint256 dailyRate) {
        uint256 newVersion = fund.getRebalanceSize();
        if (newVersion != currentVersion) {
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
}
