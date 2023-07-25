// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";
import "../layerzero/interfaces/ILayerZeroEndpoint.sol";

interface ISubSchedule {
    function lzEndpoint() external view returns (ILayerZeroEndpoint);

    function mainLzChainID() external view returns (uint16);

    function crossChainSync(bytes memory adapterParams) external payable;
}

contract CrossChainSyncKeeperHelper is KeeperCompatibleInterface, Ownable {
    uint256 private constant DATA_LENGTH = 96; // abi.encode(uint256,uint256,uint256)
    uint256 private constant SYNC_GAS_LIMIT = 90000;

    ISubSchedule public immutable subSchedule;
    uint16 public immutable mainLzChainID;
    ILayerZeroEndpoint public immutable lzEndpoint;

    uint256 public lastTimestamp;

    constructor(address subSchedule_) public {
        subSchedule = ISubSchedule(subSchedule_);
        mainLzChainID = ISubSchedule(subSchedule_).mainLzChainID();
        lzEndpoint = ISubSchedule(subSchedule_).lzEndpoint();
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
        uint256 lastTimestamp_ = lastTimestamp;
        require(block.timestamp > lastTimestamp_ + 1 weeks, "Not yet");

        (uint256 srcFees, ) =
            lzEndpoint.estimateFees(
                mainLzChainID,
                address(subSchedule),
                new bytes(DATA_LENGTH),
                false,
                abi.encodePacked(uint16(1), SYNC_GAS_LIMIT)
            );
        require(address(this).balance >= srcFees, "Not enough balance");
        subSchedule.crossChainSync{value: srcFees}(abi.encodePacked(uint16(1), SYNC_GAS_LIMIT));

        // Always skip to the lastest week
        _updateLastTimestamp(
            lastTimestamp_ + ((block.timestamp - lastTimestamp_ - 1) / 1 weeks) * 1 weeks
        );
    }

    function _updateLastTimestamp(uint256 lastTimestamp_) private {
        lastTimestamp = lastTimestamp_;
    }
}
