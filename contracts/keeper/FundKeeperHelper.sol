// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "./BatchKeeperHelperBase.sol";
import "../interfaces/IFund.sol";

interface IFundSettlement is IFund {
    function settle() external;
}

contract FundKeeperHelper is BatchKeeperHelperBase {
    constructor(address[] memory funds_) public BatchKeeperHelperBase(funds_) {}

    function _checkUpkeep(address contractAddress) internal view override returns (bool) {
        IFundSettlement fund = IFundSettlement(contractAddress);
        uint256 currentDay = fund.currentDay();
        uint256 price = fund.twapOracle().getTwap(currentDay);
        if (block.timestamp >= currentDay && price != 0) {
            return true;
        }
        return false;
    }

    function _performUpkeep(address contractAddress) internal override {
        IFundSettlement(contractAddress).settle();
    }
}
