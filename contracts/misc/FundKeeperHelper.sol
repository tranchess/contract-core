// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";
import "../interfaces/IFund.sol";

interface IFundSettlement is IFund {
    function settle() external;
}

contract FundKeeperHelper is KeeperCompatibleInterface {
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet private funds;

    constructor(address[] memory funds_) public {
        for (uint256 iFund = 0; iFund < funds_.length; iFund++) {
            funds.add(funds_[iFund]);
        }
    }

    function checkUpkeep(
        bytes calldata /*checkData*/
    ) external override returns (bool upkeepNeeded, bytes memory performData) {
        for (uint256 iFund = 0; iFund < funds.length(); iFund++) {
            IFund fund = IFund(funds.at(iFund));
            uint256 currentDay = fund.currentDay();
            uint256 price = fund.twapOracle().getTwap(currentDay);
            if (block.timestamp >= currentDay && price != 0) {
                upkeepNeeded = true;
                performData = abi.encodePacked(performData, funds.at(iFund));
            }
        }
    }

    function performUpkeep(bytes calldata performData) external override {
        uint256 fundLength = performData.length / 20;
        for (uint256 iFund = 0; iFund < fundLength; iFund++) {
            address fund;
            bytes memory fundBytes = bytes(performData[iFund * 20:(iFund + 1) * 20]);
            assembly {
                fund := mload(add(fundBytes, 20))
            }
            require(funds.contains(fund), "Not fund");
            IFundSettlement(fund).settle();
        }
    }
}
