// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";

contract BatchKeeperHelperBase is KeeperCompatibleInterface, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    event AllowlistAdded(address contractAddress);
    event AllowlistRemoved(address contractAddress);

    EnumerableSet.AddressSet private _allowlist;

    constructor(address[] memory contracts_) public {
        for (uint256 i = 0; i < contracts_.length; i++) {
            _allowlist.add(contracts_[i]);
            emit AllowlistAdded(contracts_[i]);
        }
    }

    function allowlist() external view returns (address[] memory list) {
        uint256 length = _allowlist.length();
        list = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            list[i] = _allowlist.at(i);
        }
    }

    function addAllowlist(address contractAddress) external onlyOwner {
        _allowlist.add(contractAddress);
        emit AllowlistAdded(contractAddress);
    }

    function removeAllowlist(address contractAddress) external onlyOwner {
        _allowlist.remove(contractAddress);
        emit AllowlistRemoved(contractAddress);
    }

    function checkUpkeep(bytes calldata)
        external
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 length = _allowlist.length();
        for (uint256 i = 0; i < length; i++) {
            address contractAddress = _allowlist.at(i);
            if (_checkUpkeep(contractAddress)) {
                upkeepNeeded = true;
                performData = abi.encodePacked(performData, contractAddress);
            }
        }
    }

    function performUpkeep(bytes calldata performData) external override {
        uint256 contractLength = performData.length / 20;
        require(contractLength > 0);
        for (uint256 i = 0; i < contractLength; i++) {
            address contractAddress = _getContractAddr(i);
            require(_allowlist.contains(contractAddress), "Not allowlisted");
            _performUpkeep(contractAddress);
        }
    }

    function _getContractAddr(uint256 index) private pure returns (address contractAddress) {
        assembly {
            // 0x38 = 0x4 + 0x20 + 0x14
            contractAddress := calldataload(add(0x38, mul(index, 0x14)))
        }
    }

    function _checkUpkeep(address contractAddress) internal virtual returns (bool) {}

    function _performUpkeep(address contractAddress) internal virtual {}
}
