// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IFundV5.sol";
import "../interfaces/IPrimaryMarketV5.sol";
import "../interfaces/ITrancheIndexV2.sol";

contract FeeConverter is ITrancheIndexV2 {
    IFundV5 public immutable fund;
    IPrimaryMarketV5 public immutable primaryMarket;
    address public immutable feeCollector;

    constructor(address primaryMarket_, address feeCollector_) public {
        primaryMarket = IPrimaryMarketV5(primaryMarket_);
        fund = IFundV5(IPrimaryMarketV5(primaryMarket_).fund());
        feeCollector = feeCollector_;
    }

    function collectFee() external {
        uint256 fee = fund.trancheBalanceOf(TRANCHE_Q, address(this));
        uint256 version = fund.getRebalanceSize();
        primaryMarket.redeem(feeCollector, fee, 0, version);
    }
}
