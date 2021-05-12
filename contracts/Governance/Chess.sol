// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "../interfaces/IChess.sol";
import "../utils/CoreUtility.sol";

import "./ChessRoles.sol";

contract Chess is IChess, Ownable, ERC20, ChessRoles, CoreUtility {
    using SafeMath for uint256;

    /// @dev Supply parameters
    ///      [ 100e18, 140e18, 170e18, 190e18, 200e18 ]
    // prettier-ignore
    bytes private constant CUMULATIVE_SUPPLY_SCHEDULE = 
        hex"0000000000000000000000000000000000000000000000056bc75e2d63100000"
        hex"00000000000000000000000000000000000000000000000796E3EA3F8AB00000"
        hex"0000000000000000000000000000000000000000000000093739534D28680000"
        hex"00000000000000000000000000000000000000000000000A4CC799563C380000"
        hex"00000000000000000000000000000000000000000000000AD78EBC5AC6200000";

    uint256 public immutable startTimestamp;

    constructor(uint256 startTimestamp_) public ERC20("Chess", "CHESS") ChessRoles() {
        require(startTimestamp_ > block.timestamp, "Start timestamp is not in future");
        _mint(msg.sender, getCumulativeSupply(0));
        startTimestamp = endOfWeek(startTimestamp_);
    }

    /// @notice Get length of the supply schedule
    /// @return The length of the supply schedule
    function getScheduleLength() public pure returns (uint256) {
        return CUMULATIVE_SUPPLY_SCHEDULE.length / 32;
    }

    /// @notice Get the cumulative supply at the given week index
    /// @param index Index for cumulative supply
    /// @return currentWeekCumulativeSupply The cumulative supply at the
    ///         beginning of the week
    function getCumulativeSupply(uint256 index)
        public
        pure
        returns (uint256 currentWeekCumulativeSupply)
    {
        (currentWeekCumulativeSupply, ) = getWeeklySupply(index);
    }

    /// @notice Get the total supply and weekly supply at the given week index
    /// @param index Index for weekly supply
    /// @return currentWeekCumulativeSupply The cumulative supply at the
    ///         beginning of the week
    /// @return weeklySupply Weekly supply
    function getWeeklySupply(uint256 index)
        public
        pure
        returns (uint256 currentWeekCumulativeSupply, uint256 weeklySupply)
    {
        uint256 length = getScheduleLength();
        bytes memory scheduleBytes = bytes(CUMULATIVE_SUPPLY_SCHEDULE);

        if (index < length - 1) {
            uint256 offset = (index + 1) * 32;
            uint256 nextWeekCumulativeSupply;
            assembly {
                currentWeekCumulativeSupply := mload(add(scheduleBytes, offset))
                nextWeekCumulativeSupply := mload(add(scheduleBytes, add(offset, 32)))
            }

            weeklySupply = nextWeekCumulativeSupply.sub(currentWeekCumulativeSupply);
        } else {
            uint256 offset = length * 32;
            assembly {
                currentWeekCumulativeSupply := mload(add(scheduleBytes, offset))
            }

            weeklySupply = 0;
        }
    }

    /// @notice Current number of tokens in existence (claimed or unclaimed)
    function availableSupply() public view returns (uint256) {
        if (block.timestamp < startTimestamp) {
            return getCumulativeSupply(0);
        }
        uint256 index = (block.timestamp - startTimestamp) / 1 weeks;
        uint256 currentWeek = index * 1 weeks + startTimestamp;
        (uint256 currentWeekCumulativeSupply, uint256 weeklySupply) = getWeeklySupply(index);
        return
            currentWeekCumulativeSupply.add(
                weeklySupply.mul(block.timestamp - currentWeek).div(1 weeks)
            );
    }

    /// @notice Get the release rate of CHESS token at the given timestamp
    /// @param timestamp Timestamp for release rate
    /// @return Release rate (number of CHESS token per second)
    function getRate(uint256 timestamp) external view override returns (uint256) {
        if (timestamp < startTimestamp) {
            return 0;
        }
        uint256 index = (timestamp - startTimestamp) / 1 weeks;
        (, uint256 weeklySupply) = getWeeklySupply(index);
        return weeklySupply.div(1 weeks);
    }

    /// @notice Creates `amount` CHESS tokens and assigns them to `account`,
    ///         increasing the total supply. This is guarded by `Minter` role.
    /// @param account recipient of the token
    /// @param amount amount of the token
    function mint(address account, uint256 amount) external override onlyMinter {
        require(totalSupply().add(amount) <= availableSupply(), "Exceeds allowable mint amount");
        _mint(account, amount);
    }

    function addMinter(address account) external onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }
}
