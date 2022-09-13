// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "./ITwapOracle.sol";

interface ITwapOracleV2 is ITwapOracle {
    function getLatest() external view returns (uint256);
}
