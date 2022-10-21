// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../interfaces/IChessSchedule.sol";
import "../interfaces/IControllerBallotV2.sol";
import "../utils/CoreUtility.sol";

import "./ChessRoles.sol";

import "../anyswap/AnyCallAppBase.sol";
import "../interfaces/IAnyswapV6ERC20.sol";

contract ChessSubSchedule is
    IChessSchedule,
    OwnableUpgradeable,
    ChessRoles,
    CoreUtility,
    AnyCallAppBase
{
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[32] private _reservedSlots;

    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 public immutable mainChainID;
    address public immutable scheduleRelayer;

    IControllerBallotV2 public immutable controllerBallot;

    IAnyswapV6ERC20 public immutable chess;

    /// @notice Current number of tokens in existence (claimed or unclaimed)
    uint256 public availableSupply;
    uint256 public outstandingSupply;
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

    function initialize() external initializer {
        __Ownable_init();
    }

    /// @notice Get supply of the week containing the given timestamp. This function usually
    ///         returns zero when called at the beginning of the week. After cross-chain CHESS
    ///         emission is delivered to this contract, this function returns the correct value.
    function getWeeklySupply(uint256 timestamp) public view override returns (uint256) {
        return _weeklySupplies[_endOfWeek(timestamp) - 1 weeks];
    }

    /// @notice Get the release rate of CHESS token at the given timestamp. This function usually
    ///         returns zero when called at the beginning of the week. After cross-chain CHESS
    ///         emission is delivered to this contract, this function returns the average rate over
    ///         a whole week.
    /// @param timestamp Timestamp for release rate
    /// @return Release rate (number of CHESS token per second)
    function getRate(uint256 timestamp) external view override returns (uint256) {
        return _weeklySupplies[_endOfWeek(timestamp) - 1 weeks] / 1 weeks;
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

    /// @notice Send the total veCHESS amount voted to all pools on this chain to the main chain.
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

    function _checkAnyFallbackTo(address, uint256) internal override returns (bool) {
        return false;
    }

    /// @dev Receive CHESS emission from the main chain.
    function _anyExecute(
        uint256, // fromChainID
        bytes calldata data
    ) internal override {
        uint256 totalAmount = abi.decode(data, (uint256));
        uint256 currentWeek = _endOfWeek(block.timestamp) - 1 weeks;
        uint256 outstandingSupply_ = outstandingSupply;
        // A non-zero weekly supply indicates the current weekly emission has already gone
        // into effect, so we have to delay the emission to next week.
        if (_weeklySupplies[currentWeek] == 0) {
            if (outstandingSupply_ != 0) {
                totalAmount = totalAmount.add(outstandingSupply_);
                outstandingSupply = 0;
            }
            availableSupply = availableSupply.add(totalAmount);
            _weeklySupplies[currentWeek] = totalAmount;
        } else {
            outstandingSupply = outstandingSupply_.add(totalAmount);
        }
    }

    function _anyFallback(bytes memory) internal override {
        revert("N/A");
    }
}
