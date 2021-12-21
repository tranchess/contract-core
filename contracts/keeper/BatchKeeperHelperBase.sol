// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";

contract BatchKeeperHelperBase is KeeperCompatibleInterface, Ownable {
    event AllowlistAdded(address contractAddress);
    event AllowlistRemoved(address contractAddress);

    uint256 private constant FALSE = 0;
    uint256 private constant TRUE = 1;

    mapping(address => uint256) public allowlist;

    constructor(address[] memory contracts_) public {
        for (uint256 i = 0; i < contracts_.length; i++) {
            allowlist[contracts_[i]] = TRUE;
            emit AllowlistAdded(contracts_[i]);
        }
    }

    function addAllowlist(address contractAddress) external onlyOwner {
        allowlist[contractAddress] = TRUE;
        emit AllowlistAdded(contractAddress);
    }

    function removeAllowlist(address contractAddress) external onlyOwner {
        allowlist[contractAddress] = FALSE;
        emit AllowlistRemoved(contractAddress);
    }

    function checkUpkeep(bytes calldata checkData)
        external
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 contractLength = checkData.length / 20;
        for (uint256 i = 0; i < contractLength; i++) {
            address contractAddress = _getContractAddr(i);
            require(allowlist[contractAddress] != FALSE, "Not allowlisted");
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
            require(allowlist[contractAddress] != FALSE, "Not allowlisted");
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
