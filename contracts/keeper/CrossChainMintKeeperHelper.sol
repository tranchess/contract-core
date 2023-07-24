// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.6/interfaces/KeeperCompatibleInterface.sol";
import "../layerzero/interfaces/ILayerZeroEndpoint.sol";
import "../utils/CoreUtility.sol";

interface IScheduleRelayer {
    function lzEndpoint() external view returns (ILayerZeroEndpoint);

    function subLzChainID() external view returns (uint16);

    function lastWeek() external view returns (uint256);

    function crossChainMint(bytes memory adapterParams) external payable;
}

contract CrossChainMintKeeperHelper is KeeperCompatibleInterface, Ownable, CoreUtility {
    uint256 private constant DATA_LENGTH = 32; // abi.encode(uint256)
    uint256 private constant MINT_GAS_LIMIT = 100000;

    IScheduleRelayer public immutable relayer;
    uint16 public immutable subLzChainID;
    ILayerZeroEndpoint public immutable lzEndpoint;

    constructor(address relayer_) public {
        relayer = IScheduleRelayer(relayer_);
        subLzChainID = IScheduleRelayer(relayer_).subLzChainID();
        lzEndpoint = IScheduleRelayer(relayer_).lzEndpoint();
    }

    receive() external payable {}

    function withdraw(uint256 value) external onlyOwner {
        (bool success, ) = msg.sender.call{value: value}("");
        require(success, "ETH transfer failed");
    }

    function checkUpkeep(bytes calldata)
        external
        override
        returns (bool upkeepNeeded, bytes memory)
    {
        uint256 startWeek = _endOfWeek(block.timestamp) - 1 weeks;
        uint256 lastWeek = relayer.lastWeek();
        upkeepNeeded = (startWeek > lastWeek);
    }

    function performUpkeep(bytes calldata) external override {
        (uint256 srcFees, ) =
            lzEndpoint.estimateFees(
                subLzChainID,
                address(relayer),
                new bytes(DATA_LENGTH),
                false,
                abi.encodePacked(uint16(1), MINT_GAS_LIMIT)
            );
        require(address(this).balance >= srcFees, "Not enough balance");
        relayer.crossChainMint{value: srcFees}(abi.encodePacked(uint16(1), MINT_GAS_LIMIT));
    }
}
