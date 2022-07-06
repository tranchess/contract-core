// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./MockTwapOracle.sol";
import "@chainlink/contracts/src/v0.8/interfaces/KeeperCompatibleInterface.sol";

contract MockTwapOracleKeeper is KeeperCompatibleInterface, CoreUtility {
    using SafeMath for uint256;

    MockTwapOracle private immutable mockTwap;

    constructor(address mockTwap_) {
        mockTwap = MockTwapOracle(mockTwap_);
    }

    function checkUpkeep(
        bytes calldata /*checkData*/
    ) external view override returns (bool upkeepNeeded, bytes memory performData) {
        return (block.timestamp > _endOfDay(mockTwap.lastStoredEpoch()), bytes(""));
    }

    function performUpkeep(
        bytes calldata /*performData*/
    ) external override {
        mockTwap.catchUp();
    }

    function _endOfDay(uint256 timestamp) private pure returns (uint256) {
        return ((timestamp.add(1 days) - SETTLEMENT_TIME) / 1 days) * 1 days + SETTLEMENT_TIME;
    }
}
