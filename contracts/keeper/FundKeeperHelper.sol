// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "./BatchKeeperHelperBase.sol";
import "../interfaces/IFundV3.sol";

interface IFundSettlement is IFundV3 {
    function settle() external;
}

interface IDistributor {
    function checkpoint() external;
}

contract FundKeeperHelper is BatchKeeperHelperBase {
    uint256 public delay;

    constructor(address[] memory funds_, uint256 delay_) public BatchKeeperHelperBase(funds_) {
        delay = delay_;
    }

    function updateDelay(uint256 newDelay) external onlyOwner {
        delay = newDelay;
    }

    function _checkUpkeep(address contractAddress) internal override returns (bool) {
        IFundSettlement fund = IFundSettlement(contractAddress);
        uint256 currentDay = fund.currentDay();
        uint256 price = fund.twapOracle().getTwap(currentDay);
        return (block.timestamp >= currentDay + delay && price != 0);
    }

    function _performUpkeep(address contractAddress) internal override {
        IFundSettlement(contractAddress).settle();
    }
}
