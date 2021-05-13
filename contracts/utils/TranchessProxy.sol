// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/proxy/TransparentUpgradeableProxy.sol";

contract TranchessProxy is TransparentUpgradeableProxy {
    constructor(
        address _logic,
        address _admin,
        bytes memory _data
    ) public payable TransparentUpgradeableProxy(_logic, _admin, _data) {}
}
