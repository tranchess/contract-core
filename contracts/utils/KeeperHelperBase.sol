// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";

contract KeeperHelperBase is KeeperCompatibleInterface, Ownable {
    mapping(address => bool) private allowlist;

    constructor(address[] memory contracts_) public {
        for (uint256 index = 0; index < contracts_.length; index++) {
            allowlist[contracts_[index]] = true;
        }
    }

    function toggle(address contract_) external onlyOwner {
        allowlist[contract_] = !allowlist[contract_];
    }

    function checkUpkeepView(bytes calldata checkData)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 contractLength = checkData.length / 20;
        for (uint256 index = 0; index < contractLength; index++) {
            address contractAddr = _getContractAddr(checkData, index);
            require(allowlist[contractAddr], "Not allowlisted");
            (upkeepNeeded, performData) = _checkUpkeep(contractAddr, upkeepNeeded, performData);
        }
    }

    function checkUpkeep(bytes calldata checkData)
        external
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 contractLength = checkData.length / 20;
        for (uint256 index = 0; index < contractLength; index++) {
            address contractAddr = _getContractAddr(checkData, index);
            require(allowlist[contractAddr], "Not allowlisted");
            (upkeepNeeded, performData) = _checkUpkeep(contractAddr, upkeepNeeded, performData);
        }
    }

    function performUpkeep(bytes calldata performData) external override {
        uint256 contractLength = performData.length / 20;
        for (uint256 index = 0; index < contractLength; index++) {
            address contractAddr = _getContractAddr(performData, index);
            require(allowlist[contractAddr], "Not allowlisted");
            _performUpkeep(contractAddr);
        }
    }

    function _getContractAddr(bytes calldata dataBytes, uint256 index)
        private
        pure
        returns (address contractAddr)
    {
        bytes memory contractBytes = bytes(dataBytes[index * 20:(index + 1) * 20]);
        assembly {
            contractAddr := mload(add(contractBytes, 20))
        }
    }

    function _checkUpkeep(
        address contractAddr,
        bool upkeepNeeded,
        bytes memory performData
    ) internal view virtual returns (bool, bytes memory) {}

    function _performUpkeep(address contractAddr) internal virtual {}
}
