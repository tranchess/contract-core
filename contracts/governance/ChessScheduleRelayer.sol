// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../interfaces/IChessSchedule.sol";
import "../interfaces/IChessController.sol";
import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../layerzero/NonblockingLzApp.sol";
import "../layerzero/interfaces/IOFTCore.sol";

contract ChessScheduleRelayer is CoreUtility, NonblockingLzApp {
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event CrossChainMinted(uint256 chainID, uint256 amount);
    event CrossChainSynced(uint256 chainID, uint256 week, uint256 veSupply);

    uint16 public immutable subLzChainID;

    IChessSchedule public immutable chessSchedule;

    IChessController public immutable chessController;

    address public immutable chessPool;

    address public immutable chess;

    mapping(uint256 => uint256) public veSupplyPerWeek;

    uint256 public lastWeek;

    constructor(
        uint16 subLzChainID_,
        address chessSchedule_,
        address chessController_,
        address chessPool_,
        address endpoint_
    ) public NonblockingLzApp(endpoint_) {
        subLzChainID = subLzChainID_;
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
        chessPool = chessPool_;
        chess = IOFTCore(chessPool_).token();
    }

    function crossChainMint(bytes memory adapterParams) external payable {
        uint256 startWeek = _endOfWeek(block.timestamp) - 1 weeks;
        require(startWeek > lastWeek, "Not a new week");
        lastWeek = startWeek;
        uint256 amount =
            chessSchedule.getWeeklySupply(startWeek).multiplyDecimal(
                chessController.getFundRelativeWeight(address(this), startWeek)
            );
        if (amount != 0) {
            chessSchedule.mint(chessPool, amount);
        }
        uint256 balance = IERC20(chess).balanceOf(address(this));
        if (balance != 0) {
            // Additional CHESS rewards directly transferred to this contract
            IERC20(chess).safeTransfer(chessPool, balance);
            amount += balance;
        }
        if (amount != 0) {
            _checkGasLimit(
                subLzChainID,
                0, /*type*/
                adapterParams,
                0 /*extraGas*/
            );
            _lzSend(
                subLzChainID,
                abi.encode(amount),
                msg.sender,
                address(0x0),
                adapterParams,
                msg.value
            );
            emit CrossChainMinted(subLzChainID, amount);
        }
    }

    function _nonblockingLzReceive(
        uint16,
        bytes memory,
        uint64,
        bytes memory data
    ) internal override {
        (uint256 week, uint256 supply, uint256 nextWeekSupply) =
            abi.decode(data, (uint256, uint256, uint256));
        veSupplyPerWeek[week] = supply;
        veSupplyPerWeek[week + 1 weeks] = nextWeekSupply;
        emit CrossChainSynced(subLzChainID, week, supply);
        emit CrossChainSynced(subLzChainID, week + 1 weeks, nextWeekSupply);
    }
}
