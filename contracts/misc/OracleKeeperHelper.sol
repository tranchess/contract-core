// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../utils/KeeperHelperBase.sol";

interface IChainlinkTwapOracle {
    function lastTimestamp() external view returns (uint256);

    function update() external;
}

contract OracleKeeperHelper is KeeperHelperBase {
    uint256 private constant EPOCH = 30 minutes;

    constructor(address[] memory aggregators_) public KeeperHelperBase(aggregators_) {}

    function _checkUpkeep(
        address contractAddr,
        bool upkeepNeeded,
        bytes memory performData
    ) internal view override returns (bool, bytes memory) {
        IChainlinkTwapOracle chainlinkTwap = IChainlinkTwapOracle(contractAddr);
        uint256 lastTimestamp = chainlinkTwap.lastTimestamp();
        if (block.timestamp > lastTimestamp + EPOCH) {
            return (true, abi.encodePacked(performData, contractAddr));
        }
        return (upkeepNeeded, performData);
    }

    function _performUpkeep(address contractAddr) internal override {
        IChainlinkTwapOracle(contractAddr).update();
    }
}
