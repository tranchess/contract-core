// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/SafeDecimalMath.sol";
import "../interfaces/IChess.sol";

import "./ChessRoles.sol";

contract Chess is IChess, Ownable, ERC20, ChessRoles {
    using SafeDecimalMath for uint256;

    // Supply parameters
    // prettier-ignore
    bytes public constant schedule = 
        hex"0000000000000000000000000000000000000000000000056bc75e2d63100000"
        hex"0000000000000000000000000000000000000000000000056bc75e2d63100000"
        hex"000000000000000000000000000000000000000000000005f68e8131ecf80000"
        hex"0000000000000000000000000000000000000000000000068155a43676e00000"
        hex"0000000000000000000000000000000000000000000000070c1cc73b00c80000"
        hex"00000000000000000000000000000000000000000000000796e3ea3f8ab00000"
        hex"00000000000000000000000000000000000000000000000821ab0d4414980000";

    uint256 public startTimestamp;

    constructor(uint256 _startTimestamp) public ERC20("Chess", "CHESS") ChessRoles() {
        _mint(msg.sender, getScheduledSupply(0));
        startTimestamp = _startTimestamp;
    }

    /// @notice Get the index of the given timestamp
    /// @param timestamp Timestamp for index
    /// @return Index
    function getIndex(uint256 timestamp) public view returns (uint256) {
        if (timestamp < startTimestamp) {
            return 0;
        }
        return (timestamp - startTimestamp) / 1 weeks;
    }

    function getScheduledSupply(uint256 index) public pure returns (uint256 value) {
        bytes memory scheduleBytes = bytes(schedule);
        uint256 offset = (index + 1) * 32;
        assembly {
            value := mload(add(scheduleBytes, offset))
        }
    }

    function getWeeklySupply(uint256 index)
        public
        pure
        returns (uint256 currentWeekSupply, uint256 weeklySupply)
    {
        bytes memory scheduleBytes = bytes(schedule);
        uint256 offset = (index + 1) * 32;
        uint256 nextWeekSupply;
        assembly {
            currentWeekSupply := mload(add(scheduleBytes, offset))
            nextWeekSupply := mload(add(scheduleBytes, add(offset, 32)))
        }

        weeklySupply = nextWeekSupply.sub(currentWeekSupply);
    }

    /// @notice Current number of tokens in existence (claimed or unclaimed)
    function availableSupply() public view returns (uint256) {
        return _availableSupply();
    }

    /// @notice Get the release rate of CHESS token at the given timestamp
    /// @param timestamp Timestamp for release rate
    /// @return Release rate (number of CHESS token per second)
    function getRate(uint256 timestamp) external view override returns (uint256) {
        uint256 index = getIndex(timestamp);
        (, uint256 weeklySupply) = getWeeklySupply(index);
        return weeklySupply.div(1 weeks);
    }

    /// @notice Creates `amount` CHESS tokens and assigns them to `account`,
    ///         increasing the total supply. This is guarded by `Minter` role.
    /// @param account recipient of the token
    /// @param amount amount of the token
    function mint(address account, uint256 amount) public override onlyMinter {
        require(totalSupply().add(amount) <= _availableSupply(), "exceeds allowable mint amount");
        _mint(account, amount);
    }

    function addMinter(address account) external onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }

    function _availableSupply() internal view returns (uint256) {
        uint256 index = getIndex(block.timestamp);
        uint256 currentWeek = index * 1 weeks + startTimestamp;
        (uint256 currentWeekSupply, uint256 weeklySupply) = getWeeklySupply(index);
        return currentWeekSupply.add(weeklySupply.mul(block.timestamp - currentWeek).div(1 weeks));
    }
}
