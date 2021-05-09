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
    uint256[7] public schedule = [
        100e18, // Initial Supply
        100e18, // Week 0 Supply === Initial Supply
        110e18, // Week 1 Supply
        120e18, // ...
        130e18,
        140e18,
        150e18 // Week 5 Supply
    ];
    uint256 public startTimestamp;

    constructor(uint256 _startTimestamp) public ERC20("Chess", "CHESS") ChessRoles() {
        _mint(msg.sender, schedule[0]);
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

    /// @notice Current number of tokens in existence (claimed or unclaimed)
    function availableSupply() public view returns (uint256) {
        return _availableSupply();
    }

    /// @notice Get the release rate of CHESS token at the given timestamp
    /// @param timestamp Timestamp for release rate
    /// @return Release rate (number of CHESS token per second)
    function getRate(uint256 timestamp) external view override returns (uint256) {
        uint256 index = getIndex(timestamp);
        uint256 weeklySupply = schedule[index + 1].sub(schedule[index]);
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
        uint256 weeklySupply = schedule[index + 1].sub(schedule[index]);
        return schedule[index].add(weeklySupply.mul(block.timestamp - currentWeek).div(1 weeks));
    }
}
