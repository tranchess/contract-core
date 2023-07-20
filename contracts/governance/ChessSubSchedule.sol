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

import "../layerzero/UpgradeableNonblockingLzApp.sol";
import "../layerzero/ProxyOFTPool.sol";

contract ChessSubSchedule is
    IChessSchedule,
    OwnableUpgradeable,
    ChessRoles,
    CoreUtility,
    UpgradeableNonblockingLzApp
{
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[27] private _reservedSlots;

    event WeeklySupplyUpdated(uint256 week, uint256 newSupply, uint256 newOutstandingSupply);
    event CrossChainSyncInitiated(uint256 week, uint256 veSupply, uint256 nextWeekVeSupply);

    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint16 public immutable mainLzChainID;

    IControllerBallotV2 public immutable controllerBallot;

    ProxyOFTPool public immutable chessPool;
    IERC20 public immutable chess;

    /// @notice Current number of tokens in existence (claimed or unclaimed)
    uint256 public availableSupply;
    uint256 public outstandingSupply;
    uint256 public minted;
    mapping(uint256 => uint256) private _weeklySupplies;

    constructor(
        uint16 mainLzChainID_,
        address controllerBallot_,
        address chessPool_,
        address endpoint_
    ) public UpgradeableNonblockingLzApp(endpoint_) {
        mainLzChainID = mainLzChainID_;
        controllerBallot = IControllerBallotV2(controllerBallot_);
        chessPool = ProxyOFTPool(chessPool_);
        chess = IERC20(IOFTCore(chessPool_).token());
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

    /// @notice Transfer `amount` CHESS tokens to `account`. This is guarded by `Minter` role.
    /// @param account recipient of the token
    /// @param amount amount of the token
    function mint(address account, uint256 amount) external override onlyMinter {
        require(minted.add(amount) <= availableSupply, "Exceeds allowable mint amount");
        chess.safeTransfer(account, amount);
        minted = minted.add(amount);
    }

    function addMinter(address account) external override onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }

    function distributeOutstanding() external onlyOwner {
        uint256 outstandingSupply_ = outstandingSupply;
        if (outstandingSupply_ != 0) {
            uint256 currentWeek = _endOfWeek(block.timestamp) - 1 weeks;
            availableSupply = availableSupply.add(outstandingSupply_);
            _weeklySupplies[currentWeek] = _weeklySupplies[currentWeek].add(outstandingSupply_);
            outstandingSupply = 0;
            emit WeeklySupplyUpdated(currentWeek, _weeklySupplies[currentWeek], 0);
        }
    }

    /// @notice Send the total veCHESS amount voted to all pools on this chain to the main chain.
    function crossChainSync(bytes memory adapterParams) external payable {
        uint256 week = _endOfWeek(block.timestamp);
        uint256 supply = controllerBallot.totalSupplyAtWeek(week);
        uint256 nextWeekSupply = controllerBallot.totalSupplyAtWeek(week + 1 weeks);

        _checkGasLimit(
            mainLzChainID,
            0, /*type*/
            adapterParams,
            0 /*extraGas*/
        );
        _lzSend(
            mainLzChainID,
            abi.encode(week, supply, nextWeekSupply),
            msg.sender == tx.origin ? msg.sender : payable(owner()), // To avoid reentrancy
            address(0x0),
            adapterParams,
            msg.value
        );

        emit CrossChainSyncInitiated(week, supply, nextWeekSupply);
    }

    /// @dev Receive CHESS emission from the main chain. Create the `totalAmount`of CHESS,
    /// increasing the total supply.
    function _nonblockingLzReceive(
        uint16,
        bytes memory,
        uint64,
        bytes memory data
    ) internal override {
        uint256 totalAmount = abi.decode(data, (uint256));
        uint256 currentWeek = _endOfWeek(block.timestamp) - 1 weeks;
        uint256 outstandingSupply_ = outstandingSupply;
        // A non-zero weekly supply indicates the current weekly emission has already gone
        // into effect, so we have to delay the emission to next week.
        if (_weeklySupplies[currentWeek] == 0) {
            if (outstandingSupply_ != 0) {
                totalAmount = totalAmount.add(outstandingSupply_);
                outstandingSupply_ = 0;
            }
            availableSupply = availableSupply.add(totalAmount);
            _weeklySupplies[currentWeek] = totalAmount;
            chessPool.withdrawUnderlying(totalAmount);
        } else {
            outstandingSupply_ = outstandingSupply_.add(totalAmount);
        }
        outstandingSupply = outstandingSupply_;
        emit WeeklySupplyUpdated(currentWeek, totalAmount, outstandingSupply_);
    }
}
