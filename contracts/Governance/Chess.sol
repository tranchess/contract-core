// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/SafeDecimalMath.sol";
import "../interfaces/IChess.sol";

import "./ChessRoles.sol";

contract Chess is IChess, Ownable, ERC20, ChessRoles {
    using SafeDecimalMath for uint256;

    uint256 public constant YEAR = 86400 * 365;

    // Supply parameters
    uint256 public constant INITIAL_SUPPLY = 1303030303 * 10**18;
    uint256 public constant INITIAL_RATE = (274815283 * 10**18) / YEAR; // leading to 43% premine
    uint256 public constant RATE_REDUCTION_TIME = YEAR;
    uint256 public constant RATE_REDUCTION_COEFFICIENT = 1189207115002721024; // 2 ** (1/4) * 1e18;
    uint256 public constant RATE_DENOMINATOR = 10**18;
    uint256 public constant INFLATION_DELAY = 86400;

    event UpdateMiningParameters(uint256 time, uint256 rate, uint256 supply);

    // Supply variables
    int128 public miningDay;
    uint256 public startDayTime;
    uint256 public override rate;

    uint256 public startDaySupply;

    constructor() public ERC20("Chess", "CHESS") ChessRoles() {
        _mint(msg.sender, INITIAL_SUPPLY);

        startDayTime = block.timestamp + INFLATION_DELAY - RATE_REDUCTION_TIME;
        miningDay = -1;
        rate = 0;
        startDaySupply = INITIAL_SUPPLY;
    }

    /**
        @notice Current number of tokens in existence (claimed or unclaimed)
     */
    function availableSupply() public view returns (uint256) {
        return _availableSupply();
    }

    function addMinter(address account) external onlyOwner {
        _addMinter(account);
    }

    function removeMinter(address account) external onlyOwner {
        _removeMinter(account);
    }

    /**
    @notice Update mining rate and supply at the start of the day
    @dev Callable by any address, but only once per day
         Total supply becomes slightly larger if this function is called late
     */
    function updateMiningParameters() public {
        require(block.timestamp >= startDayTime + RATE_REDUCTION_TIME, "too soon!");
        _updateMiningParameters();
    }

    /**
    @notice Get timestamp of the current mining day start
                while simultaneously updating mining parameters
    @return Timestamp of the day
     */
    function startDayTimeWrite() public returns (uint256) {
        uint256 _startDayTime = startDayTime;
        if (block.timestamp >= _startDayTime + RATE_REDUCTION_TIME) {
            _updateMiningParameters();
            return startDayTime;
        }
        return _startDayTime;
    }

    /**
    @notice Get timestamp of the next mining day start
                while simultaneously updating mining parameters
    @return Timestamp of the next day
     */
    function futureDayTimeWrite() public override returns (uint256, uint256) {
        uint256 _startDayTime = startDayTime;
        if (block.timestamp >= _startDayTime + RATE_REDUCTION_TIME) {
            _updateMiningParameters();
            return (startDayTime + RATE_REDUCTION_TIME, rate);
        }
        return (_startDayTime + RATE_REDUCTION_TIME, rate);
    }

    function mint(address account, uint256 amount) public override onlyMinter {
        if (block.timestamp >= startDayTime + RATE_REDUCTION_TIME) {
            _updateMiningParameters();
        }

        require(totalSupply() + amount <= _availableSupply(), "exceeds allowable mint amount");
        _mint(account, amount);
    }

    // -------------------------------------------------------------------------
    function _availableSupply() internal view returns (uint256) {
        return startDaySupply + (block.timestamp - startDayTime) * rate;
    }

    /**
    @dev Update mining rate and supply at the start of the day
         Any modifying mining call must also call this
     */
    function _updateMiningParameters() internal {
        uint256 _rate = rate;
        uint256 _startDaySupply = startDaySupply;

        startDayTime += RATE_REDUCTION_TIME;
        miningDay += 1;

        if (_rate == 0) {
            _rate = INITIAL_RATE;
        } else {
            _startDaySupply += _rate * RATE_REDUCTION_TIME;
            startDaySupply = _startDaySupply;
            _rate = _rate.divideDecimal(RATE_REDUCTION_COEFFICIENT);
        }
        rate = _rate;

        emit UpdateMiningParameters(block.timestamp, _rate, _startDaySupply);
    }
}
