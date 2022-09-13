// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../interfaces/IChessSchedule.sol";
import "../interfaces/IChessController.sol";
import "../utils/CoreUtility.sol";
import "../utils/SafeDecimalMath.sol";
import "../anyswap/AnyCallAppBase.sol";
import "../anyswap/IAnyswapV6ERC20.sol";

contract ChessSubScheduleRelayer is CoreUtility, AnyCallAppBase {
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event CrossChainMinted(uint256 chainID, uint256 amount);
    event CrossChainSynced(uint256 chainID, uint256 week, uint256 veSupply);

    uint256 public immutable subChainID;

    address public immutable subSchedule;

    IChessSchedule public immutable chessSchedule;

    IChessController public immutable chessController;

    address public immutable anyswapChessPool;

    address public immutable chess;

    mapping(uint256 => uint256) public veSupplyPerWeek;

    uint256 public lastWeek;

    constructor(
        uint256 subChainID_,
        address subSchedule_,
        address chessSchedule_,
        address chessController_,
        address anyswapChessPool_,
        address anyCallProxy_
    ) public AnyCallAppBase(anyCallProxy_, false, false) {
        subChainID = subChainID_;
        subSchedule = subSchedule_;
        chessSchedule = IChessSchedule(chessSchedule_);
        chessController = IChessController(chessController_);
        anyswapChessPool = anyswapChessPool_;
        chess = IAnyswapV6ERC20(anyswapChessPool_).underlying();
    }

    function crossChainMint() external {
        uint256 startWeek = _endOfWeek(block.timestamp) - 1 weeks;
        if (startWeek <= lastWeek) {
            return;
        }
        lastWeek = startWeek;
        uint256 amount =
            chessSchedule.getWeeklySupply(startWeek).multiplyDecimal(
                chessController.getFundRelativeWeight(address(this), startWeek)
            );
        if (amount != 0) {
            chessSchedule.mint(anyswapChessPool, amount);
        }
        uint256 balance = IERC20(chess).balanceOf(address(this));
        if (balance != 0) {
            // Additional CHESS rewards directly transferred to this contract
            IERC20(chess).safeTransfer(anyswapChessPool, balance);
            amount += balance;
        }
        if (amount != 0) {
            _anyCall(subSchedule, abi.encode(amount), subChainID);
            emit CrossChainMinted(subChainID, amount);
        }
    }

    function _checkAnyExecuteFrom(address from, uint256 fromChainID)
        internal
        override
        returns (bool)
    {
        return from == subSchedule && fromChainID == subChainID;
    }

    function _anyExecute(uint256, bytes calldata data) internal override {
        (uint256 week, uint256 supply, uint256 nextWeekSupply) =
            abi.decode(data, (uint256, uint256, uint256));
        veSupplyPerWeek[week] = supply;
        veSupplyPerWeek[week + 1 weeks] = nextWeekSupply;
        emit CrossChainSynced(subChainID, week, supply);
        emit CrossChainSynced(subChainID, week + 1 weeks, nextWeekSupply);
    }

    function _anyFallback(address, bytes calldata) internal override {
        revert("N/A");
    }
}
