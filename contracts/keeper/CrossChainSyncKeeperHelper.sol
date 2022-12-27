// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";

interface IAnyCallProxy {
    function calcSrcFees(
        address _app,
        uint256 _toChainID,
        uint256 _dataLength
    ) external view returns (uint256);
}

interface ISubSchedule {
    function anyCallProxy() external view returns (address);

    function mainChainID() external view returns (uint256);

    function crossChainSync() external payable;
}

contract CrossChainSyncKeeperHelper is KeeperCompatibleInterface, Ownable {
    uint256 public constant DATA_LENGTH = 96; // abi.encode(uint256,uint256,uint256)

    ISubSchedule public immutable subSchedule;
    uint256 public immutable mainChainID;
    address public immutable anyCallProxy;

    uint256 public lastTimestamp;

    constructor(address subSchedule_) public {
        subSchedule = ISubSchedule(subSchedule_);
        mainChainID = ISubSchedule(subSchedule_).mainChainID();
        anyCallProxy = ISubSchedule(subSchedule_).anyCallProxy();
        _updateLastTimestamp(block.timestamp);
    }

    receive() external payable {}

    function withdraw(uint256 value) external onlyOwner {
        (bool success, ) = msg.sender.call{value: value}("");
        require(success, "ETH transfer failed");
    }

    function updateLastTimestamp(uint256 lastTimestamp_) external onlyOwner {
        _updateLastTimestamp(lastTimestamp_);
    }

    function checkUpkeep(bytes calldata)
        external
        override
        returns (bool upkeepNeeded, bytes memory)
    {
        upkeepNeeded = (block.timestamp > lastTimestamp + 1 weeks);
    }

    function performUpkeep(bytes calldata) external override {
        require(block.timestamp > lastTimestamp + 1 weeks, "Not yet");

        uint256 srcFees =
            IAnyCallProxy(anyCallProxy).calcSrcFees(address(subSchedule), mainChainID, DATA_LENGTH);
        require(address(this).balance >= srcFees, "Not enough balance");
        subSchedule.crossChainSync{value: srcFees}();

        // Always skip to the lastest week
        uint256 lastTimestamp_ = lastTimestamp;
        _updateLastTimestamp(
            lastTimestamp_ + ((block.timestamp - lastTimestamp_ - 1) / 1 weeks) * 1 weeks
        );
    }

    function _updateLastTimestamp(uint256 lastTimestamp_) private {
        lastTimestamp = lastTimestamp_;
    }
}
