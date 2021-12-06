// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";
import "../interfaces/IFund.sol";

interface IFundSettlement is IFund {
    function settle() external;
}

contract FundKeeperHelper is KeeperCompatibleInterface, Ownable {
    mapping(address => bool) private funds;

    constructor(address[] memory funds_) public {
        for (uint256 iFund = 0; iFund < funds_.length; iFund++) {
            funds[funds_[iFund]] = true;
        }
    }

    function toggleFund(address fund_) external onlyOwner {
        funds[fund_] = !funds[fund_];
    }

    function checkUpkeepView(bytes calldata checkData)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 fundLength = checkData.length / 20;
        for (uint256 iFund = 0; iFund < fundLength; iFund++) {
            address fundAddr;
            bytes memory fundBytes = bytes(checkData[iFund * 20:(iFund + 1) * 20]);
            assembly {
                fundAddr := mload(add(fundBytes, 20))
            }
            require(funds[fundAddr], "Not fund");

            IFundSettlement fund = IFundSettlement(fundAddr);
            uint256 currentDay = fund.currentDay();
            uint256 price = fund.twapOracle().getTwap(currentDay);
            if (block.timestamp >= currentDay && price != 0) {
                upkeepNeeded = true;
                performData = abi.encodePacked(performData, fundBytes);
            }
        }
    }

    function checkUpkeep(bytes calldata checkData)
        external
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 fundLength = checkData.length / 20;
        for (uint256 iFund = 0; iFund < fundLength; iFund++) {
            address fundAddr;
            bytes memory fundBytes = bytes(checkData[iFund * 20:(iFund + 1) * 20]);
            assembly {
                fundAddr := mload(add(fundBytes, 20))
            }
            require(funds[fundAddr], "Not fund");

            IFundSettlement fund = IFundSettlement(fundAddr);
            uint256 currentDay = fund.currentDay();
            uint256 price = fund.twapOracle().getTwap(currentDay);
            if (block.timestamp >= currentDay && price != 0) {
                upkeepNeeded = true;
                performData = abi.encodePacked(performData, fundBytes);
            }
        }
    }

    function performUpkeep(bytes calldata performData) external override {
        uint256 fundLength = performData.length / 20;
        for (uint256 iFund = 0; iFund < fundLength; iFund++) {
            address fundAddr;
            bytes memory fundBytes = bytes(performData[iFund * 20:(iFund + 1) * 20]);
            assembly {
                fundAddr := mload(add(fundBytes, 20))
            }
            require(funds[fundAddr], "Not fund");
            IFundSettlement(fundAddr).settle();
        }
    }
}
