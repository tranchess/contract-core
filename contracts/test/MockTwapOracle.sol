// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../interfaces/ITwapOracle.sol";

contract MockTwapOracle is ITwapOracle {
    uint256 public constant FUND_PERIOD = 24 hours;

    mapping(uint256 => uint256) private prices;

    constructor() public {
        prices[0] = 1e18;
    }

    function getTwap(uint256 timestamp) public view override returns (uint256) {
        return prices[timestamp];
    }

    function updatePrice(uint256 timestamp, uint256 price) public {
        prices[timestamp] = price;
    }

    function updateYesterdayPrice(uint256 price) public {
        uint256 timestamp = ((block.timestamp - 14 hours) / 1 days) * 1 days + 14 hours;
        prices[timestamp] = price;
    }
}
