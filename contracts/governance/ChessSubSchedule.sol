// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/IChessSchedule.sol";
import "../interfaces/IControllerBallotV2.sol";
import "../utils/CoreUtility.sol";

import "./ChessRoles.sol";

import "../anyswap/AnyCallAppBase.sol";
import "../interfaces/IAnyswapV6ERC20.sol";

contract ChessSubSchedule is IChessSchedule, Ownable, ChessRoles, CoreUtility, AnyCallAppBase {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 public immutable mainChainID;
    address public immutable scheduleRelayer;

    IControllerBallotV2 public immutable controllerBallot;

    IAnyswapV6ERC20 public immutable chess;

    /// @notice Current number of tokens in existence (claimed or unclaimed)
    uint256 public availableSupply;
    uint256 public minted;
    mapping(uint256 => uint256) private _weeklySupplies;

    constructor(
        uint256 mainChainID_,
        address scheduleRelayer_,
        address controllerBallot_,
        address chess_,
        address anyCallProxy_
    ) public AnyCallAppBase(anyCallProxy_, true, false) {
        mainChainID = mainChainID_;
        scheduleRelayer = scheduleRelayer_;
        controllerBallot = IControllerBallotV2(controllerBallot_);
        chess = IAnyswapV6ERC20(chess_);
    }

    function getWeeklySupply(uint256 timestamp) public view override returns (uint256) {
        return _weeklySupplies[timestamp];
    }

    /// @notice Get the release rate of CHESS token at the given timestamp
    /// @param timestamp Timestamp for release rate
    /// @return Release rate (number of CHESS token per second)
    function getRate(uint256 timestamp) external view override returns (uint256) {
        return _weeklySupplies[timestamp].div((timestamp + 1) * 1 weeks - block.timestamp);
    }

    /// @notice Creates `amount` CHESS tokens and assigns them to `account`,
    ///         increasing the total supply. This is guarded by `Minter` role.
    /// @param account recipient of the token
    /// @param amount amount of the token
    function mint(address account, uint256 amount) external override onlyMinter {
        require(minted.add(amount) <= availableSupply, "Exceeds allowable mint amount");
        chess.mint(account, amount);
        minted = minted.add(amount);
    }

    function addMinter(address account) external override onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }

    function crossChainSync() external payable {
        uint256 week = _endOfWeek(block.timestamp);
        uint256 supply = controllerBallot.totalSupplyAtWeek(week);
        uint256 nextWeekSupply = controllerBallot.totalSupplyAtWeek(week + 1 weeks);
        _anyCall(scheduleRelayer, mainChainID, abi.encode(week, supply, nextWeekSupply));
    }

    function _checkAnyExecuteFrom(address from, uint256 fromChainID)
        internal
        override
        returns (bool)
    {
        return from == scheduleRelayer && fromChainID == mainChainID;
    }

    /// @dev Crosschain chess emission (step 4)
    /// Receive emissions from mainchain
    function _anyExecute(
        uint256, /*fromChainID*/
        bytes calldata data
    ) internal override {
        uint256 totalAmount = abi.decode(data, (uint256));
        uint256 currentWeek = _endOfWeek(block.timestamp) - 1 weeks;
        availableSupply = availableSupply.add(totalAmount);
        _weeklySupplies[currentWeek] = totalAmount;
    }

    function _anyFallback(bytes calldata) internal override {
        revert("N/A");
    }
}
