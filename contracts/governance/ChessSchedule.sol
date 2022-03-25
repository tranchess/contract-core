// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../interfaces/IChessSchedule.sol";
import "../utils/CoreUtility.sol";

import "./ChessRoles.sol";

contract ChessSchedule is IChessSchedule, OwnableUpgradeable, ChessRoles, CoreUtility {
    /// @dev Reserved storage slots for future base contract upgrades
    uint256[32] private _reservedSlots;

    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 public constant MAX_SUPPLY = 120_000_000e18;

    /// @dev Hard-coded cumulative weekly supply. Please refer to the whitepaper for details.
    ///      Below are the concrete numbers in this list, which are also tested in "test/chessSchedule.ts".
    ///
    ///      ```
    ///         300000    900000   1800000   3000000   5400000   7704000   9915840  12039206  14077638  16034532
    ///       17913151  19716625  21447960  23110041  24705640  26237414  27707917  29119601  30474817  31775824
    ///       33037801  34261919  35449313  36601086  37718305  38802007  39853199  40872855  41861921  42921315
    ///       43931928  44894622  45810235  46679580  47503444  48302592  49077766  49829685  50559047  51266527
    ///       51959858  52639322  53305197  53957754  54597261  55223977  55838159  56440057  57029917  57607980
    ///      ```
    bytes private constant CUMULATIVE_SUPPLY_SCHEDULE =
        hex"000000000000000000000000000000000000000000003f870857a3e0e380000000000000000000000000000000000000000000000000be951906eba2aa800000000000000000000000000000000000000000000000017d2a320dd74555000000000000000000000000000000000000000000000000027b46536c66c8e300000000000000000000000000000000000000000000000004777e962985cfff000000000000000000000000000000000000000000000000065f62ad457aa39f0000000000000000000000000000000000000000000000000833c2c374cc129f00000000000000000000000000000000000000000000000009f566aa3e18d928d800000000000000000000000000000000000000000000000ba50e48ffcd3def5800000000000000000000000000000000000000000000000d4371b8b190797d1000000000000000000000000000000000000000000000000ed141dc8c1e6e659c0000000000000000000000000000000000000000000000104f28620947a945a4000000000000000000000000000000000000000000000011bdc83dca5db1a5600000000000000000000000000000000000000000000000131dbdd53a5724eec40000000000000000000000000000000000000000000000146f9f6d938553a8a0000000000000000000000000000000000000000000000015b3fd101e26da27d8000000000000000000000000000000000000000000000016eb6130b8f80c68140000000000000000000000000000000000000000000000181650bbb9e9a9b324000000000000000000000000000000000000000000000019354b23ced790486400000000000000000000000000000000000000000000001a48cadee3f50e3f4000000000000000000000000000000000000000000000001b5406c7ea3059ae0400000000000000000000000000000000000000000000001c573e59c54139431c00000000000000000000000000000000000000000000001d52af1bbf2e3022e400000000000000000000000000000000000000000000001e4694d90b274c853800000000000000000000000000000000000000000000001f33296942ab5917e400000000000000000000000000000000000000000000002018a503a9d012eafc000000000000000000000000000000000000000000000020f73e3f2f422970dc000000000000000000000000000000000000000000000021cf29e8ca212387fc000000000000000000000000000000000000000000000022a09b48dd90e1bfe400000000000000000000000000000000000000000000002380f126009ae94fac00000000000000000000000000000000000000000000002456f296c5adc1756000000000000000000000000000000000000000000000002522ce55d3fa57d3b8000000000000000000000000000000000000000000000025e4b1d0c190c25c0c0000000000000000000000000000000000000000000000269cc91a32a98ba6f00000000000000000000000000000000000000000000000274b3edbf8eeff4cd0000000000000000000000000000000000000000000000027f478c257eb6de800000000000000000000000000000000000000000000000028989f06a12b8ea45800000000000000000000000000000000000000000000002937d8a2f5d1f4a3b4000000000000000000000000000000000000000000000029d24b6e0804764cbc00000000000000000000000000000000000000000000002a681bff597ec5fc1c00000000000000000000000000000000000000000000002afaed8bd921b3118800000000000000000000000000000000000000000000002b8acf5d102f23f12800000000000000000000000000000000000000000000002c17d085050e30619400000000000000000000000000000000000000000000002ca1ffb499270695a800000000000000000000000000000000000000000000002d296b730bbdb9ca1400000000000000000000000000000000000000000000002dae21cab5aa0c590400000000000000000000000000000000000000000000002e3030aa2e56594ddc00000000000000000000000000000000000000000000002eafa59ee82e12204400000000000000000000000000000000000000000000002f2c8dfed2c1d9aa5400000000000000000000000000000000000000000000002fa6f6da7a10d081300000";

    IERC20 public immutable chess;
    uint256 public immutable startTimestamp;

    uint256 public minted;

    constructor(address chess_, uint256 startTimestamp_) public ChessRoles() {
        require(
            _endOfWeek(startTimestamp_ - 1) == startTimestamp_,
            "Start timestamp is not start of a trading week"
        );
        chess = IERC20(chess_);
        startTimestamp = startTimestamp_;
    }

    /// @notice Initialize ownership and deposit tokens.
    function initialize() external initializer {
        __Ownable_init();
        chess.safeTransferFrom(msg.sender, address(this), MAX_SUPPLY);
    }

    /// @notice Get length of the supply schedule
    /// @return The length of the supply schedule
    function getScheduleLength() public pure returns (uint256) {
        return CUMULATIVE_SUPPLY_SCHEDULE.length / 32;
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
        bytes memory scheduleBytes = CUMULATIVE_SUPPLY_SCHEDULE;
        if (index == 0) {
            assembly {
                weeklySupply := mload(add(scheduleBytes, 32))
            }
        } else if (index < length) {
            uint256 offset = index * 32;
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
        }
    }

    /// @notice Current number of tokens in existence (claimed or unclaimed)
    function availableSupply() public view returns (uint256) {
        if (block.timestamp < startTimestamp) {
            return 0;
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
        require(minted.add(amount) <= availableSupply(), "Exceeds allowable mint amount");
        chess.safeTransfer(account, amount);
        minted = minted.add(amount);
    }

    function addMinter(address account) external override onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }
}
