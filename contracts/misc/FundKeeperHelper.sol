// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../utils/KeeperHelperBase.sol";
import "../interfaces/IFund.sol";

interface IFundSettlement is IFund {
    function settle() external;
}

contract FundKeeperHelper is KeeperHelperBase {
    constructor(address[] memory funds_) public KeeperHelperBase(funds_) {}

    function _checkUpkeep(
        address contractAddr,
        bool upkeepNeeded,
        bytes memory performData
    ) internal view override returns (bool, bytes memory) {
        IFundSettlement fund = IFundSettlement(contractAddr);
        uint256 currentDay = fund.currentDay();
        uint256 price = fund.twapOracle().getTwap(currentDay);
        if (block.timestamp >= currentDay && price != 0) {
            return (true, abi.encodePacked(performData, contractAddr));
        }
        return (upkeepNeeded, performData);
    }

    function _performUpkeep(address contractAddr) internal override {
        IFundSettlement(contractAddr).settle();
    }
}
