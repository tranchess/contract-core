// SPDX-License-Identifier: GPL-3.0-or-later
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
    ///       58174482  58729653  59273722  59806909  60329432  60841504  61343336  61835130  62317089  62789409
    ///       63252282  63705898  64150441  64586093  65013033  65431434  65841466  66243298  66637094  67023013
    ///       67405073  67783313  68157770  68528483  68895489  69258824  69618526  69974632  70327176  70676194
    ///       71025213  71374232  71723250  72072269  72421288  72770306  73119325  73468344  73817362  74166381
    ///       74515399  74864418  75213437  75562455  75911474  76260493  76609511  76958530  77307549  77656567
    ///       77656567  78354605  78703623  79052642  79401661  79750679  80099698  80448717  80797735  81146754
    ///       81495773  81844791  82193810  82542829  82891847  83240866  83589884  83938903  84287922  84636940
    ///       84636940  85334978  85683996  86033015  86382034  86731052  87080071  87429090  87778108  88127127
    ///       88476146  88825164  89174183  89523202  89872220  90221239  90570258  90919276  91268295  91617314
    ///      ```
    bytes private constant CUMULATIVE_SUPPLY_SCHEDULE =
        hex"000000000000000000000000000000000000000000003f870857a3e0e3800000"
        hex"00000000000000000000000000000000000000000000be951906eba2aa800000"
        hex"000000000000000000000000000000000000000000017d2a320dd74555000000"
        hex"000000000000000000000000000000000000000000027b46536c66c8e3000000"
        hex"00000000000000000000000000000000000000000004777e962985cfff000000"
        hex"000000000000000000000000000000000000000000065f62ad457aa39f000000"
        hex"0000000000000000000000000000000000000000000833c2c374cc129f000000"
        hex"00000000000000000000000000000000000000000009f566aa3e18d928d80000"
        hex"0000000000000000000000000000000000000000000ba50e48ffcd3def580000"
        hex"0000000000000000000000000000000000000000000d4371b8b190797d100000"
        hex"0000000000000000000000000000000000000000000ed141dc8c1e6e659c0000"
        hex"000000000000000000000000000000000000000000104f28620947a945a40000"
        hex"00000000000000000000000000000000000000000011bdc83dca5db1a5600000"
        hex"000000000000000000000000000000000000000000131dbdd53a5724eec40000"
        hex"000000000000000000000000000000000000000000146f9f6d938553a8a00000"
        hex"00000000000000000000000000000000000000000015b3fd101e26da27d80000"
        hex"00000000000000000000000000000000000000000016eb6130b8f80c68140000"
        hex"000000000000000000000000000000000000000000181650bbb9e9a9b3240000"
        hex"00000000000000000000000000000000000000000019354b23ced79048640000"
        hex"0000000000000000000000000000000000000000001a48cadee3f50e3f400000"
        hex"0000000000000000000000000000000000000000001b5406c7ea3059ae040000"
        hex"0000000000000000000000000000000000000000001c573e59c54139431c0000"
        hex"0000000000000000000000000000000000000000001d52af1bbf2e3022e40000"
        hex"0000000000000000000000000000000000000000001e4694d90b274c85380000"
        hex"0000000000000000000000000000000000000000001f33296942ab5917e40000"
        hex"0000000000000000000000000000000000000000002018a503a9d012eafc0000"
        hex"00000000000000000000000000000000000000000020f73e3f2f422970dc0000"
        hex"00000000000000000000000000000000000000000021cf29e8ca212387fc0000"
        hex"00000000000000000000000000000000000000000022a09b48dd90e1bfe40000"
        hex"0000000000000000000000000000000000000000002380f126009ae94fac0000"
        hex"0000000000000000000000000000000000000000002456f296c5adc175600000"
        hex"0000000000000000000000000000000000000000002522ce55d3fa57d3b80000"
        hex"00000000000000000000000000000000000000000025e4b1d0c190c25c0c0000"
        hex"000000000000000000000000000000000000000000269cc91a32a98ba6f00000"
        hex"000000000000000000000000000000000000000000274b3edbf8eeff4cd00000"
        hex"00000000000000000000000000000000000000000027f478c257eb6de8000000"
        hex"00000000000000000000000000000000000000000028989f06a12b8ea4580000"
        hex"0000000000000000000000000000000000000000002937d8a2f5d1f4a3b40000"
        hex"00000000000000000000000000000000000000000029d24b6e0804764cbc0000"
        hex"0000000000000000000000000000000000000000002a681bff597ec5fc1c0000"
        hex"0000000000000000000000000000000000000000002afaed8bd921b311880000"
        hex"0000000000000000000000000000000000000000002b8acf5d102f23f1280000"
        hex"0000000000000000000000000000000000000000002c17d085050e3061940000"
        hex"0000000000000000000000000000000000000000002ca1ffb499270695a80000"
        hex"0000000000000000000000000000000000000000002d296b730bbdb9ca140000"
        hex"0000000000000000000000000000000000000000002dae21cab5aa0c59040000"
        hex"0000000000000000000000000000000000000000002e3030aa2e56594ddc0000"
        hex"0000000000000000000000000000000000000000002eafa59ee82e1220440000"
        hex"0000000000000000000000000000000000000000002f2c8dfed2c1d9aa540000"
        hex"0000000000000000000000000000000000000000002fa6f6da7a10d081300000"
        hex"000000000000000000000000000000000000000000301eecfd068894f5080000"
        hex"00000000000000000000000000000000000000000030947cde5c4e8f69b40000"
        hex"0000000000000000000000000000000000000000003107b2e87ed1749ba80000"
        hex"00000000000000000000000000000000000000000031789b088b13a864d40000"
        hex"00000000000000000000000000000000000000000031e7410fdcaa2750600000"
        hex"0000000000000000000000000000000000000000003253b08a6b986ba4800000"
        hex"00000000000000000000000000000000000000000032bdf4e86e748858a00000"
        hex"0000000000000000000000000000000000000000003326191d35683f81a80000"
        hex"000000000000000000000000000000000000000000338c2829f15406dbe40000"
        hex"00000000000000000000000000000000000000000033f02caeae196a8fe40000"
        hex"00000000000000000000000000000000000000000034523113f4bf2828a80000"
        hex"00000000000000000000000000000000000000000034b23fa68cde95e2680000"
        hex"0000000000000000000000000000000000000000003510625ff9c8d40d040000"
        hex"000000000000000000000000000000000000000000356ca31dfd619ba9940000"
        hex"00000000000000000000000000000000000000000035c70b94b7688ac3040000"
        hex"000000000000000000000000000000000000000000361fa52503550977e80000"
        hex"000000000000000000000000000000000000000000367679061a7a64f0a80000"
        hex"00000000000000000000000000000000000000000036cb9061557536ae480000"
        hex"000000000000000000000000000000000000000000371ef41aa95095ecd80000"
        hex"0000000000000000000000000000000000000000003770acd0a78617a3740000"
        hex"00000000000000000000000000000000000000000037c1945443a57511a40000"
        hex"0000000000000000000000000000000000000000003811acc2b9840cb7a40000"
        hex"0000000000000000000000000000000000000000003860f81d8389d5c6e80000"
        hex"00000000000000000000000000000000000000000038af7881dd8c2ebfac0000"
        hex"00000000000000000000000000000000000000000038fd2ff141f30ed3640000"
        hex"000000000000000000000000000000000000000000394a205f4a6fb98c200000"
        hex"00000000000000000000000000000000000000000039964bdb5220d9c2b80000"
        hex"00000000000000000000000000000000000000000039e1b466d36e66a8a00000"
        hex"0000000000000000000000000000000000000000003a2c5bd9a69c3c79200000"
        hex"0000000000000000000000000000000000000000003a764427655b9ebe480000"
        hex"0000000000000000000000000000000000000000003ac02c8304d1b4aad40000"
        hex"0000000000000000000000000000000000000000003b0a14dea447ca97600000"
        hex"0000000000000000000000000000000000000000003b53fd2c63072cdc880000"
        hex"0000000000000000000000000000000000000000003b9de588027d42c9140000"
        hex"0000000000000000000000000000000000000000003be7cde3a1f358b5a00000"
        hex"0000000000000000000000000000000000000000003c31b63160b2bafac80000"
        hex"0000000000000000000000000000000000000000003c7b9e8d0028d0e7540000"
        hex"0000000000000000000000000000000000000000003cc586e89f9ee6d3e00000"
        hex"0000000000000000000000000000000000000000003d0f6f365e5e4919080000"
        hex"0000000000000000000000000000000000000000003d595791fdd45f05940000"
        hex"0000000000000000000000000000000000000000003da33fdfbc93c14abc0000"
        hex"0000000000000000000000000000000000000000003ded283b5c09d737480000"
        hex"0000000000000000000000000000000000000000003e371096fb7fed23d40000"
        hex"0000000000000000000000000000000000000000003e80f8e4ba3f4f68fc0000"
        hex"0000000000000000000000000000000000000000003ecae14059b56555880000"
        hex"0000000000000000000000000000000000000000003f14c99bf92b7b42140000"
        hex"0000000000000000000000000000000000000000003f5eb1e9b7eadd873c0000"
        hex"0000000000000000000000000000000000000000003fa89a455760f373c80000"
        hex"0000000000000000000000000000000000000000003ff282a0f6d70960540000"
        hex"000000000000000000000000000000000000000000403c6aeeb5966ba57c0000"
        hex"000000000000000000000000000000000000000000403c6aeeb5966ba57c0000"
        hex"00000000000000000000000000000000000000000040d03ba5f482977e940000"
        hex"000000000000000000000000000000000000000000411a23f3b341f9c3bc0000"
        hex"00000000000000000000000000000000000000000041640c4f52b80fb0480000"
        hex"00000000000000000000000000000000000000000041adf4aaf22e259cd40000"
        hex"00000000000000000000000000000000000000000041f7dcf8b0ed87e1fc0000"
        hex"0000000000000000000000000000000000000000004241c55450639dce880000"
        hex"000000000000000000000000000000000000000000428badafefd9b3bb140000"
        hex"00000000000000000000000000000000000000000042d595fdae9916003c0000"
        hex"000000000000000000000000000000000000000000431f7e594e0f2becc80000"
        hex"000000000000000000000000000000000000000000436966b4ed8541d9540000"
        hex"00000000000000000000000000000000000000000043b34f02ac44a41e7c0000"
        hex"00000000000000000000000000000000000000000043fd375e4bbaba0b080000"
        hex"00000000000000000000000000000000000000000044471fb9eb30cff7940000"
        hex"00000000000000000000000000000000000000000044910807a9f0323cbc0000"
        hex"00000000000000000000000000000000000000000044daf06349664829480000"
        hex"0000000000000000000000000000000000000000004524d8b10825aa6e700000"
        hex"000000000000000000000000000000000000000000456ec10ca79bc05afc0000"
        hex"00000000000000000000000000000000000000000045b8a9684711d647880000"
        hex"000000000000000000000000000000000000000000460291b605d1388cb00000"
        hex"000000000000000000000000000000000000000000460291b605d1388cb00000"
        hex"0000000000000000000000000000000000000000004696626d44bd6465c80000"
        hex"00000000000000000000000000000000000000000046e04abb037cc6aaf00000"
        hex"000000000000000000000000000000000000000000472a3316a2f2dc977c0000"
        hex"00000000000000000000000000000000000000000047741b724268f284080000"
        hex"00000000000000000000000000000000000000000047be03c0012854c9300000"
        hex"0000000000000000000000000000000000000000004807ec1ba09e6ab5bc0000"
        hex"0000000000000000000000000000000000000000004851d477401480a2480000"
        hex"000000000000000000000000000000000000000000489bbcc4fed3e2e7700000"
        hex"00000000000000000000000000000000000000000048e5a5209e49f8d3fc0000"
        hex"000000000000000000000000000000000000000000492f8d7c3dc00ec0880000"
        hex"000000000000000000000000000000000000000000497975c9fc7f7105b00000"
        hex"00000000000000000000000000000000000000000049c35e259bf586f23c0000"
        hex"0000000000000000000000000000000000000000004a0d46813b6b9cdec80000"
        hex"0000000000000000000000000000000000000000004a572ecefa2aff23f00000"
        hex"0000000000000000000000000000000000000000004aa1172a99a115107c0000"
        hex"0000000000000000000000000000000000000000004aeaff8639172afd080000"
        hex"0000000000000000000000000000000000000000004b34e7d3f7d68d42300000"
        hex"0000000000000000000000000000000000000000004b7ed02f974ca32ebc0000"
        hex"0000000000000000000000000000000000000000004bc8b88b36c2b91b480000";

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

    /// @notice Get supply of the week containing the given timestamp.
    /// @param timestamp Any timestamp in the week to be queried
    /// @return weeklySupply Weekly supply
    function getWeeklySupply(
        uint256 timestamp
    ) public view override returns (uint256 weeklySupply) {
        if (timestamp < startTimestamp) {
            return 0;
        }
        (, weeklySupply) = _getWeeklySupply((timestamp - startTimestamp) / 1 weeks);
    }

    function _getWeeklySupply(
        uint256 index
    ) private pure returns (uint256 currentWeekCumulativeSupply, uint256 weeklySupply) {
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

    /// @notice Current number of tokens in existence (claimed or unclaimed) by the end of
    ///         the current week.
    function availableSupply() public view returns (uint256) {
        if (block.timestamp < startTimestamp) {
            return 0;
        }
        (uint256 currentWeekCumulativeSupply, uint256 weeklySupply) = _getWeeklySupply(
            (block.timestamp - startTimestamp) / 1 weeks
        );
        return currentWeekCumulativeSupply.add(weeklySupply);
    }

    /// @notice Get the emission rate of CHESS token at the given timestamp
    /// @param timestamp Timestamp for emission rate
    /// @return Release rate (number of CHESS token per second)
    function getRate(uint256 timestamp) external view override returns (uint256) {
        return getWeeklySupply(timestamp) / 1 weeks;
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
