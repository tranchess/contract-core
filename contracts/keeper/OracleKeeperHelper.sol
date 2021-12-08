// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "./BatchKeeperHelperBase.sol";

interface IChainlinkTwapOracle {
    function lastTimestamp() external view returns (uint256);

    function update() external;
}

contract OracleKeeperHelper is BatchKeeperHelperBase {
    uint256 private constant EPOCH = 30 minutes;

    constructor(address[] memory oracles_) public BatchKeeperHelperBase(oracles_) {}

    function _checkUpkeep(address contractAddress) internal view override returns (bool) {
        IChainlinkTwapOracle chainlinkTwap = IChainlinkTwapOracle(contractAddress);
        uint256 lastTimestamp = chainlinkTwap.lastTimestamp();
        return (block.timestamp > lastTimestamp + EPOCH);
    }

    function _performUpkeep(address contractAddress) internal override {
        IChainlinkTwapOracle(contractAddress).update();
    }
}
