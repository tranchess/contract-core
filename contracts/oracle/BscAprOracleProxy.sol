// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/IAprOracle.sol";
import "../interfaces/IFundV3.sol";

contract BscAprOracleProxy is IAprOracle {
    address public immutable aprOracle;
    uint256 public immutable lockedVersion;

    constructor(address aprOracle_, uint256 lockedVersion_) public {
        aprOracle = aprOracle_;
        lockedVersion = lockedVersion_;
    }

    function capture() external override returns (uint256 dailyRate) {
        require(IFundV3(msg.sender).getRebalanceSize() == lockedVersion, "Version locked");

        return IAprOracle(aprOracle).capture();
    }
}
