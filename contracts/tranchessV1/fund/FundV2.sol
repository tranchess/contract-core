// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../../utils/SafeDecimalMath.sol";
import "../../utils/CoreUtility.sol";

import "../interfaces/IPrimaryMarketV2.sol";
import "../interfaces/IFundV2.sol";
import "../../interfaces/ITwapOracle.sol";
import "../../interfaces/IAprOracle.sol";
import "../../interfaces/IBallot.sol";
import "../../interfaces/IVotingEscrow.sol";
import "../interfaces/ITrancheIndex.sol";

import "./FundRoles.sol";

contract FundV2 is IFundV2, Ownable, ReentrancyGuard, FundRoles, CoreUtility, ITrancheIndex {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event StrategyUpdateProposed(
        address indexed newStrategy,
        uint256 minTimestamp,
        uint256 maxTimestamp
    );
    event StrategyUpdated(address indexed previousStrategy, address indexed newStrategy);
    event ProfitReported(uint256 profit, uint256 performanceFee);
    event LossReported(uint256 loss);
    event ObsoletePrimaryMarketAdded(address obsoletePrimaryMarket);
    event NewPrimaryMarketAdded(address newPrimaryMarket);
    event DailyProtocolFeeRateUpdated(uint256 newDailyProtocolFeeRate);
    event TwapOracleUpdated(address newTwapOracle);
    event AprOracleUpdated(address newAprOracle);
    event BallotUpdated(address newBallot);
    event FeeCollectorUpdated(address newFeeCollector);
    event ActivityDelayTimeUpdated(uint256 delayTime);

    uint256 private constant UNIT = 1e18;
    uint256 private constant MAX_INTEREST_RATE = 0.2e18; // 20% daily
    uint256 private constant MAX_DAILY_PROTOCOL_FEE_RATE = 0.05e18; // 5% daily rate

    uint256 private constant WEIGHT_A = 1;
    uint256 private constant WEIGHT_B = 1;
    uint256 private constant WEIGHT_M = WEIGHT_A + WEIGHT_B;

    uint256 private constant STRATEGY_UPDATE_MIN_DELAY = 3 days;
    uint256 private constant STRATEGY_UPDATE_MAX_DELAY = 7 days;

    /// @notice Upper bound of `NAV_B / NAV_A` to trigger a rebalance.
    uint256 public immutable upperRebalanceThreshold;

    /// @notice Lower bound of `NAV_B / NAV_A` to trigger a rebalance.
    uint256 public immutable lowerRebalanceThreshold;

    /// @notice Address of the underlying token.
    address public immutable override tokenUnderlying;

    /// @notice A multipler that normalizes an underlying balance to 18 decimal places.
    uint256 public immutable override underlyingDecimalMultiplier;

    /// @notice Daily protocol fee rate.
    uint256 public dailyProtocolFeeRate;

    /// @notice TwapOracle address for the underlying asset.
    ITwapOracle public override twapOracle;

    /// @notice AprOracle address.
    IAprOracle public aprOracle;

    /// @notice Address of the interest rate ballot.
    IBallot public ballot;

    /// @notice Fee Collector address.
    address public override feeCollector;

    /// @notice Address of Token M.
    address public override tokenM;

    /// @notice Address of Token A.
    address public override tokenA;

    /// @notice Address of Token B.
    address public override tokenB;

    /// @notice End timestamp of the current trading day.
    ///         A trading day starts at UTC time `SETTLEMENT_TIME` of a day (inclusive)
    ///         and ends at the same time of the next day (exclusive).
    uint256 public override currentDay;

    /// @notice Start timestamp of the current primary market activity window.
    uint256 public override fundActivityStartTime;

    /// @notice Start timestamp of the current exchange activity window.
    uint256 public override exchangeActivityStartTime;

    uint256 public activityDelayTimeAfterRebalance;

    /// @dev Historical rebalances. Rebalances are often accessed in loops with bounds checking.
    ///      So we store them in a fixed-length array, in order to make compiler-generated
    ///      bounds checking on every access cheaper. The actual length of this array is stored in
    ///      `_rebalanceSize` and should be explicitly checked when necessary.
    Rebalance[65535] private _rebalances;

    /// @dev Historical rebalance count.
    uint256 private _rebalanceSize;

    /// @dev Total share supply of the three tranches. They are always rebalanced to the latest
    ///      version.
    uint256[TRANCHE_COUNT] private _totalSupplies;

    /// @dev Mapping of account => share balance of the three tranches.
    ///      Rebalance versions are stored in a separate mapping `_balanceVersions`.
    mapping(address => uint256[TRANCHE_COUNT]) private _balances;

    /// @dev Rebalance version mapping for `_balances`.
    mapping(address => uint256) private _balanceVersions;

    /// @dev Mapping of owner => spender => share allowance of the three tranches.
    ///      Rebalance versions are stored in a separate mapping `_allowanceVersions`.
    mapping(address => mapping(address => uint256[TRANCHE_COUNT])) private _allowances;

    /// @dev Rebalance version mapping for `_allowances`.
    mapping(address => mapping(address => uint256)) private _allowanceVersions;

    /// @dev Mapping of trading day => NAV tuple.
    mapping(uint256 => uint256[TRANCHE_COUNT]) private _historicalNavs;

    /// @notice Mapping of trading day => total fund shares.
    ///
    ///         Key is the end timestamp of a trading day. Value is the total fund shares after
    ///         settlement of that trading day, as if all Token A and B are merged.
    mapping(uint256 => uint256) public override historicalTotalShares;

    /// @notice Mapping of trading day => underlying assets in the fund.
    ///
    ///         Key is the end timestamp of a trading day. Value is the underlying assets in
    ///         the fund after settlement of that trading day.
    mapping(uint256 => uint256) public override historicalUnderlying;

    /// @notice Mapping of trading week => interest rate of Token A.
    ///
    ///         Key is the end timestamp of a trading week. Value is the interest rate captured
    ///         after settlement of the last day of the previous trading week.
    mapping(uint256 => uint256) public historicalInterestRate;

    address[] private obsoletePrimaryMarkets;
    address[] private newPrimaryMarkets;

    /// @notice Amount of fee not transfered to the fee collector yet.
    uint256 public feeDebt;

    /// @dev Mapping of primary market => Amount of redemption underlying that the fund owes
    ///      the primary market
    mapping(address => uint256) public redemptionDebts;

    /// @dev Sum of the fee debt and redemption debts of all primary markets.
    uint256 private _totalDebt;

    address public strategy;

    address public proposedStrategy;

    uint256 private _proposedStrategyTimestamp;

    uint256 private _strategyUnderlying;

    constructor(
        address tokenUnderlying_,
        uint256 underlyingDecimals_,
        uint256 dailyProtocolFeeRate_,
        uint256 upperRebalanceThreshold_,
        uint256 lowerRebalanceThreshold_,
        address twapOracle_,
        address aprOracle_,
        address ballot_,
        address feeCollector_
    ) public Ownable() FundRoles() {
        tokenUnderlying = tokenUnderlying_;
        require(underlyingDecimals_ <= 18, "Underlying decimals larger than 18");
        underlyingDecimalMultiplier = 10**(18 - underlyingDecimals_);
        require(
            dailyProtocolFeeRate_ <= MAX_DAILY_PROTOCOL_FEE_RATE,
            "Exceed max protocol fee rate"
        );
        dailyProtocolFeeRate = dailyProtocolFeeRate_;
        upperRebalanceThreshold = upperRebalanceThreshold_;
        lowerRebalanceThreshold = lowerRebalanceThreshold_;
        twapOracle = ITwapOracle(twapOracle_);
        aprOracle = IAprOracle(aprOracle_);
        ballot = IBallot(ballot_);
        feeCollector = feeCollector_;

        currentDay = endOfDay(block.timestamp);
        uint256 lastDay = currentDay - 1 days;
        uint256 currentPrice = twapOracle.getTwap(lastDay);
        require(currentPrice != 0, "Price not available");
        _historicalNavs[lastDay][TRANCHE_M] = UNIT;
        _historicalNavs[lastDay][TRANCHE_A] = UNIT;
        _historicalNavs[lastDay][TRANCHE_B] = UNIT;
        historicalInterestRate[_endOfWeek(lastDay)] = MAX_INTEREST_RATE.min(aprOracle.capture());
        fundActivityStartTime = lastDay;
        exchangeActivityStartTime = lastDay + 30 minutes;
        activityDelayTimeAfterRebalance = 12 hours;
    }

    function initialize(
        address tokenM_,
        address tokenA_,
        address tokenB_,
        address primaryMarket_,
        address strategy_
    ) external onlyOwner {
        require(tokenM == address(0) && tokenM_ != address(0), "Already initialized");
        tokenM = tokenM_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        _initializeRoles(tokenM_, tokenA_, tokenB_, primaryMarket_);
        emit StrategyUpdated(strategy, strategy_);
        strategy = strategy_;
    }

    /// @notice Return weights of Token A and B when splitting Token M.
    /// @return weightA Weight of Token A
    /// @return weightB Weight of Token B
    function trancheWeights() external pure override returns (uint256 weightA, uint256 weightB) {
        return (WEIGHT_A, WEIGHT_B);
    }

    /// @notice UTC time of a day when the fund settles.
    function settlementTime() external pure returns (uint256) {
        return SETTLEMENT_TIME;
    }

    /// @notice Return end timestamp of the trading day containing a given timestamp.
    ///
    ///         A trading day starts at UTC time `SETTLEMENT_TIME` of a day (inclusive)
    ///         and ends at the same time of the next day (exclusive).
    /// @param timestamp The given timestamp
    /// @return End timestamp of the trading day.
    function endOfDay(uint256 timestamp) public pure override returns (uint256) {
        return ((timestamp.add(1 days) - SETTLEMENT_TIME) / 1 days) * 1 days + SETTLEMENT_TIME;
    }

    /// @notice Return end timestamp of the trading week containing a given timestamp.
    ///
    ///         A trading week starts at UTC time `SETTLEMENT_TIME` on a Thursday (inclusive)
    ///         and ends at the same time of the next Thursday (exclusive).
    /// @param timestamp The given timestamp
    /// @return End timestamp of the trading week.
    function endOfWeek(uint256 timestamp) external pure returns (uint256) {
        return _endOfWeek(timestamp);
    }

    /// @notice Return the status of the fund contract.
    /// @param timestamp Timestamp to assess
    /// @return True if the fund contract is active
    function isFundActive(uint256 timestamp) public view override returns (bool) {
        return timestamp >= fundActivityStartTime;
    }

    /// @notice Return the status of a given primary market contract.
    /// @param primaryMarket The primary market contract address
    /// @param timestamp Timestamp to assess
    /// @return True if the primary market contract is active
    function isPrimaryMarketActive(address primaryMarket, uint256 timestamp)
        public
        view
        override
        returns (bool)
    {
        return
            isPrimaryMarket(primaryMarket) &&
            timestamp >= fundActivityStartTime &&
            timestamp < currentDay;
    }

    /// @notice Return the status of the exchange. Unlike the primary market, exchange is
    ///         anonymous to fund
    /// @param timestamp Timestamp to assess
    /// @return True if the exchange contract is active
    function isExchangeActive(uint256 timestamp) public view override returns (bool) {
        return (timestamp >= exchangeActivityStartTime && timestamp < (currentDay - 60 minutes));
    }

    function getTotalUnderlying() public view override returns (uint256) {
        uint256 hot = IERC20(tokenUnderlying).balanceOf(address(this));
        return hot.add(_strategyUnderlying).sub(_totalDebt);
    }

    function getStrategyUnderlying() external view override returns (uint256) {
        return _strategyUnderlying;
    }

    function getTotalDebt() external view override returns (uint256) {
        return _totalDebt;
    }

    /// @notice Total shares of the fund, as if all Token A and B are merged.
    function getTotalShares() public view override returns (uint256) {
        return
            _totalSupplies[TRANCHE_M].add(_totalSupplies[TRANCHE_A]).add(_totalSupplies[TRANCHE_B]);
    }

    /// @notice Return the rebalance matrix at a given index. A zero struct is returned
    ///         if `index` is out of bound.
    /// @param index Rebalance index
    /// @return A rebalance matrix
    function getRebalance(uint256 index) external view override returns (Rebalance memory) {
        return _rebalances[index];
    }

    /// @notice Return timestamp of the transaction triggering the rebalance at a given index.
    ///         Zero is returned if `index` is out of bound.
    /// @param index Rebalance index
    /// @return Timestamp of the rebalance
    function getRebalanceTimestamp(uint256 index) external view override returns (uint256) {
        return _rebalances[index].timestamp;
    }

    /// @notice Return the number of historical rebalances.
    function getRebalanceSize() external view override returns (uint256) {
        return _rebalanceSize;
    }

    /// @notice Return NAV of Token M, A and B of the given trading day.
    /// @param day End timestamp of a trading day
    /// @return NAV of Token M, A and B
    function historicalNavs(uint256 day)
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return (
            _historicalNavs[day][TRANCHE_M],
            _historicalNavs[day][TRANCHE_A],
            _historicalNavs[day][TRANCHE_B]
        );
    }

    /// @notice Estimate NAV of all tranches at a given timestamp, considering underlying price
    ///         change, accrued protocol fee and accrued interest since the previous settlement.
    ///
    ///         The extrapolation uses simple interest instead of daily compound interest in
    ///         calculating protocol fee and Token A's interest. There may be significant error
    ///         in the returned values when `timestamp` is far beyond the last settlement.
    /// @param timestamp Timestamp to estimate
    /// @param price Price of the underlying asset (18 decimal places)
    /// @return Estimated NAV of all tranches
    function extrapolateNav(uint256 timestamp, uint256 price)
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        // Find the last settled trading day before the given timestamp.
        uint256 previousDay = currentDay - 1 days;
        if (previousDay > timestamp) {
            previousDay = endOfDay(timestamp) - 1 days;
        }
        uint256 previousShares = historicalTotalShares[previousDay];
        uint256 navM = _extrapolateNavM(previousDay, previousShares, timestamp, price);
        uint256 navA = _extrapolateNavA(previousDay, previousShares, timestamp);
        uint256 navB = calculateNavB(navM, navA);
        return (navM, navA, navB);
    }

    function _extrapolateNavM(
        uint256 previousDay,
        uint256 previousShares,
        uint256 timestamp,
        uint256 price
    ) private view returns (uint256) {
        uint256 navM;
        if (previousShares == 0) {
            // The fund is empty. Just return the previous recorded NAV.
            navM = _historicalNavs[previousDay][TRANCHE_M];
            if (navM == 0) {
                // No NAV is recorded because the given timestamp is before the fund launches.
                return UNIT;
            } else {
                return navM;
            }
        }
        uint256 totalValue =
            price.mul(historicalUnderlying[previousDay].mul(underlyingDecimalMultiplier));
        uint256 accruedFee =
            totalValue.multiplyDecimal(dailyProtocolFeeRate).mul(timestamp - previousDay).div(
                1 days
            );
        navM = (totalValue - accruedFee).div(previousShares);
        return navM;
    }

    function _extrapolateNavA(
        uint256 previousDay,
        uint256 previousShares,
        uint256 timestamp
    ) private view returns (uint256) {
        uint256 navA = _historicalNavs[previousDay][TRANCHE_A];
        if (previousShares == 0) {
            // The fund is empty. Just return the previous recorded NAV.
            if (navA == 0) {
                // No NAV is recorded because the given timestamp is before the fund launches.
                return UNIT;
            } else {
                return navA;
            }
        }

        uint256 week = _endOfWeek(previousDay);
        uint256 newNavA =
            navA
                .multiplyDecimal(
                UNIT.sub(dailyProtocolFeeRate.mul(timestamp - previousDay).div(1 days))
            )
                .multiplyDecimal(
                UNIT.add(historicalInterestRate[week].mul(timestamp - previousDay).div(1 days))
            );
        return newNavA > navA ? newNavA : navA;
    }

    function calculateNavB(uint256 navM, uint256 navA) public pure override returns (uint256) {
        // Using unchecked multiplications because they are unlikely to overflow
        if (navM * WEIGHT_M >= navA * WEIGHT_A) {
            return (navM * WEIGHT_M - navA * WEIGHT_A) / WEIGHT_B;
        } else {
            return 0;
        }
    }

    /// @notice Transform share amounts according to the rebalance at a given index.
    ///         This function performs no bounds checking on the given index. A non-existent
    ///         rebalance transforms anything to a zero vector.
    /// @param amountM Amount of Token M before the rebalance
    /// @param amountA Amount of Token A before the rebalance
    /// @param amountB Amount of Token B before the rebalance
    /// @param index Rebalance index
    /// @return newAmountM Amount of Token M after the rebalance
    /// @return newAmountA Amount of Token A after the rebalance
    /// @return newAmountB Amount of Token B after the rebalance
    function doRebalance(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 index
    )
        public
        view
        override
        returns (
            uint256 newAmountM,
            uint256 newAmountA,
            uint256 newAmountB
        )
    {
        Rebalance storage rebalance = _rebalances[index];
        newAmountM = amountM
            .multiplyDecimal(rebalance.ratioM)
            .add(amountA.multiplyDecimal(rebalance.ratioA2M))
            .add(amountB.multiplyDecimal(rebalance.ratioB2M));
        uint256 ratioAB = rebalance.ratioAB; // Gas saver
        newAmountA = amountA.multiplyDecimal(ratioAB);
        newAmountB = amountB.multiplyDecimal(ratioAB);
    }

    /// @notice Transform share amounts according to rebalances in a given index range,
    ///         This function performs no bounds checking on the given indices. The original amounts
    ///         are returned if `fromIndex` is no less than `toIndex`. A zero vector is returned
    ///         if `toIndex` is greater than the number of existing rebalances.
    /// @param amountM Amount of Token M before the rebalance
    /// @param amountA Amount of Token A before the rebalance
    /// @param amountB Amount of Token B before the rebalance
    /// @param fromIndex Starting of the rebalance index range, inclusive
    /// @param toIndex End of the rebalance index range, exclusive
    /// @return newAmountM Amount of Token M after the rebalance
    /// @return newAmountA Amount of Token A after the rebalance
    /// @return newAmountB Amount of Token B after the rebalance
    function batchRebalance(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 fromIndex,
        uint256 toIndex
    )
        external
        view
        override
        returns (
            uint256 newAmountM,
            uint256 newAmountA,
            uint256 newAmountB
        )
    {
        for (uint256 i = fromIndex; i < toIndex; i++) {
            (amountM, amountA, amountB) = doRebalance(amountM, amountA, amountB, i);
        }
        newAmountM = amountM;
        newAmountA = amountA;
        newAmountB = amountB;
    }

    /// @notice Transform share balance to a given rebalance version, or to the latest version
    ///         if `targetVersion` is zero.
    /// @param account Account of the balance to rebalance
    /// @param targetVersion The target rebalance version, or zero for the latest version
    function refreshBalance(address account, uint256 targetVersion) external override {
        if (targetVersion > 0) {
            require(targetVersion <= _rebalanceSize, "Target version out of bound");
        }
        _refreshBalance(account, targetVersion);
    }

    /// @notice Transform allowance to a given rebalance version, or to the latest version
    ///         if `targetVersion` is zero.
    /// @param owner Owner of the allowance to rebalance
    /// @param spender Spender of the allowance to rebalance
    /// @param targetVersion The target rebalance version, or zero for the latest version
    function refreshAllowance(
        address owner,
        address spender,
        uint256 targetVersion
    ) external override {
        if (targetVersion > 0) {
            require(targetVersion <= _rebalanceSize, "Target version out of bound");
        }
        _refreshAllowance(owner, spender, targetVersion);
    }

    function shareBalanceOf(uint256 tranche, address account)
        external
        view
        override
        returns (uint256)
    {
        uint256 amountM = _balances[account][TRANCHE_M];
        uint256 amountA = _balances[account][TRANCHE_A];
        uint256 amountB = _balances[account][TRANCHE_B];

        if (tranche == TRANCHE_M) {
            if (amountM == 0 && amountA == 0 && amountB == 0) return 0;
        } else if (tranche == TRANCHE_A) {
            if (amountA == 0) return 0;
        } else {
            if (amountB == 0) return 0;
        }

        uint256 size = _rebalanceSize; // Gas saver
        for (uint256 i = _balanceVersions[account]; i < size; i++) {
            (amountM, amountA, amountB) = doRebalance(amountM, amountA, amountB, i);
        }

        if (tranche == TRANCHE_M) {
            return amountM;
        } else if (tranche == TRANCHE_A) {
            return amountA;
        } else {
            return amountB;
        }
    }

    /// @notice Return all three share balances transformed to the latest rebalance version.
    /// @param account Owner of the shares
    function allShareBalanceOf(address account)
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        uint256 amountM = _balances[account][TRANCHE_M];
        uint256 amountA = _balances[account][TRANCHE_A];
        uint256 amountB = _balances[account][TRANCHE_B];

        uint256 size = _rebalanceSize; // Gas saver
        for (uint256 i = _balanceVersions[account]; i < size; i++) {
            (amountM, amountA, amountB) = doRebalance(amountM, amountA, amountB, i);
        }

        return (amountM, amountA, amountB);
    }

    function shareBalanceVersion(address account) external view override returns (uint256) {
        return _balanceVersions[account];
    }

    function shareAllowance(
        uint256 tranche,
        address owner,
        address spender
    ) external view override returns (uint256) {
        uint256 allowanceM = _allowances[owner][spender][TRANCHE_M];
        uint256 allowanceA = _allowances[owner][spender][TRANCHE_A];
        uint256 allowanceB = _allowances[owner][spender][TRANCHE_B];

        if (tranche == TRANCHE_M) {
            if (allowanceM == 0) return 0;
        } else if (tranche == TRANCHE_A) {
            if (allowanceA == 0) return 0;
        } else {
            if (allowanceB == 0) return 0;
        }

        uint256 size = _rebalanceSize; // Gas saver
        for (uint256 i = _allowanceVersions[owner][spender]; i < size; i++) {
            (allowanceM, allowanceA, allowanceB) = _rebalanceAllowance(
                allowanceM,
                allowanceA,
                allowanceB,
                i
            );
        }

        if (tranche == TRANCHE_M) {
            return allowanceM;
        } else if (tranche == TRANCHE_A) {
            return allowanceA;
        } else {
            return allowanceB;
        }
    }

    function shareAllowanceVersion(address owner, address spender)
        external
        view
        override
        returns (uint256)
    {
        return _allowanceVersions[owner][spender];
    }

    function shareTotalSupply(uint256 tranche) external view override returns (uint256) {
        return _totalSupplies[tranche];
    }

    function mint(
        uint256 tranche,
        address account,
        uint256 amount
    ) external override onlyPrimaryMarket {
        _refreshBalance(account, _rebalanceSize);
        _mint(tranche, account, amount);
    }

    function burn(
        uint256 tranche,
        address account,
        uint256 amount
    ) external override onlyPrimaryMarket {
        _refreshBalance(account, _rebalanceSize);
        _burn(tranche, account, amount);
    }

    function transfer(
        uint256 tranche,
        address sender,
        address recipient,
        uint256 amount
    ) public override onlyShare {
        require(isFundActive(block.timestamp), "Transfer is inactive");
        _refreshBalance(sender, _rebalanceSize);
        _refreshBalance(recipient, _rebalanceSize);
        _transfer(tranche, sender, recipient, amount);
    }

    function transferFrom(
        uint256 tranche,
        address spender,
        address sender,
        address recipient,
        uint256 amount
    ) external override onlyShare returns (uint256 newAllowance) {
        transfer(tranche, sender, recipient, amount);

        _refreshAllowance(sender, spender, _rebalanceSize);
        newAllowance = _allowances[sender][spender][tranche].sub(
            amount,
            "ERC20: transfer amount exceeds allowance"
        );
        _approve(tranche, sender, spender, newAllowance);
    }

    function approve(
        uint256 tranche,
        address owner,
        address spender,
        uint256 amount
    ) external override onlyShare {
        _refreshAllowance(owner, spender, _rebalanceSize);
        _approve(tranche, owner, spender, amount);
    }

    function increaseAllowance(
        uint256 tranche,
        address sender,
        address spender,
        uint256 addedValue
    ) external override onlyShare returns (uint256 newAllowance) {
        _refreshAllowance(sender, spender, _rebalanceSize);
        newAllowance = _allowances[sender][spender][tranche].add(addedValue);
        _approve(tranche, sender, spender, newAllowance);
    }

    function decreaseAllowance(
        uint256 tranche,
        address sender,
        address spender,
        uint256 subtractedValue
    ) external override onlyShare returns (uint256 newAllowance) {
        _refreshAllowance(sender, spender, _rebalanceSize);
        newAllowance = _allowances[sender][spender][tranche].sub(subtractedValue);
        _approve(tranche, sender, spender, newAllowance);
    }

    function _transfer(
        uint256 tranche,
        address sender,
        address recipient,
        uint256 amount
    ) private {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");

        _balances[sender][tranche] = _balances[sender][tranche].sub(
            amount,
            "ERC20: transfer amount exceeds balance"
        );
        _balances[recipient][tranche] = _balances[recipient][tranche].add(amount);

        emit Transfer(tranche, sender, recipient, amount);
    }

    function _mint(
        uint256 tranche,
        address account,
        uint256 amount
    ) private {
        require(account != address(0), "ERC20: mint to the zero address");

        _totalSupplies[tranche] = _totalSupplies[tranche].add(amount);
        _balances[account][tranche] = _balances[account][tranche].add(amount);

        emit Transfer(tranche, address(0), account, amount);
    }

    function _burn(
        uint256 tranche,
        address account,
        uint256 amount
    ) private {
        require(account != address(0), "ERC20: burn from the zero address");

        _balances[account][tranche] = _balances[account][tranche].sub(
            amount,
            "ERC20: burn amount exceeds balance"
        );
        _totalSupplies[tranche] = _totalSupplies[tranche].sub(amount);

        emit Transfer(tranche, account, address(0), amount);
    }

    function _approve(
        uint256 tranche,
        address owner,
        address spender,
        uint256 amount
    ) private {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");

        _allowances[owner][spender][tranche] = amount;

        emit Approval(tranche, owner, spender, amount);
    }

    /// @notice Settle the current trading day. Settlement includes the following changes
    ///         to the fund.
    ///
    ///         1. Charge protocol fee of the day.
    ///         2. Settle all pending creations and redemptions from all primary markets.
    ///         3. Calculate NAV of the day and trigger rebalance if necessary.
    ///         4. Capture new interest rate for Token A.
    function settle() external nonReentrant {
        uint256 day = currentDay;
        uint256 currentWeek = _endOfWeek(day - 1 days);
        require(block.timestamp >= day, "The current trading day does not end yet");
        uint256 price = twapOracle.getTwap(day);
        require(price != 0, "Underlying price for settlement is not ready yet");

        _collectFee();

        _settlePrimaryMarkets(day, price);

        _payDebt();

        // Calculate NAV
        uint256 totalShares = getTotalShares();
        uint256 underlying = getTotalUnderlying();
        uint256 navA = _historicalNavs[day - 1 days][TRANCHE_A];
        uint256 navM;
        if (totalShares > 0) {
            navM = price.mul(underlying.mul(underlyingDecimalMultiplier)).div(totalShares);
            if (historicalTotalShares[day - 1 days] > 0) {
                // Update NAV of Token A only when the fund is non-empty both before and after
                // this settlement
                uint256 newNavA =
                    navA.multiplyDecimal(UNIT.sub(dailyProtocolFeeRate)).multiplyDecimal(
                        historicalInterestRate[currentWeek].add(UNIT)
                    );
                if (navA < newNavA) {
                    navA = newNavA;
                }
            }
        } else {
            // If the fund is empty, use NAV of Token M in the last day
            navM = _historicalNavs[day - 1 days][TRANCHE_M];
        }
        uint256 navB = calculateNavB(navM, navA);

        if (_shouldTriggerRebalance(navA, navB)) {
            _triggerRebalance(day, navM, navA, navB);
            navM = UNIT;
            navA = UNIT;
            navB = UNIT;
            totalShares = getTotalShares();
            fundActivityStartTime = day + activityDelayTimeAfterRebalance;
            exchangeActivityStartTime = day + activityDelayTimeAfterRebalance;
        } else {
            fundActivityStartTime = day;
            exchangeActivityStartTime = day + 30 minutes;
        }

        if (day == currentWeek) {
            historicalInterestRate[currentWeek + 1 weeks] = _updateInterestRate(currentWeek);
        }

        historicalTotalShares[day] = totalShares;
        historicalUnderlying[day] = underlying;
        _historicalNavs[day][TRANCHE_M] = navM;
        _historicalNavs[day][TRANCHE_A] = navA;
        _historicalNavs[day][TRANCHE_B] = navB;
        currentDay = day + 1 days;

        if (obsoletePrimaryMarkets.length > 0) {
            for (uint256 i = 0; i < obsoletePrimaryMarkets.length; i++) {
                _removePrimaryMarket(obsoletePrimaryMarkets[i]);
            }
            delete obsoletePrimaryMarkets;
        }

        if (newPrimaryMarkets.length > 0) {
            for (uint256 i = 0; i < newPrimaryMarkets.length; i++) {
                _addPrimaryMarket(newPrimaryMarkets[i]);
            }
            delete newPrimaryMarkets;
        }

        emit Settled(day, navM, navA, navB);
    }

    modifier onlyStrategy() {
        require(msg.sender == strategy, "Only strategy");
        _;
    }

    function transferToStrategy(uint256 amount) external override onlyStrategy {
        _strategyUnderlying = _strategyUnderlying.add(amount);
        IERC20(tokenUnderlying).safeTransfer(strategy, amount);
    }

    function transferFromStrategy(uint256 amount) external override onlyStrategy {
        _strategyUnderlying = _strategyUnderlying.sub(amount);
        IERC20(tokenUnderlying).safeTransferFrom(strategy, address(this), amount);
        _payDebt();
    }

    function reportProfit(uint256 profit, uint256 performanceFee) external override onlyStrategy {
        require(profit >= performanceFee, "Performance fee cannot exceed profit");
        _strategyUnderlying = _strategyUnderlying.add(profit);
        feeDebt = feeDebt.add(performanceFee);
        _totalDebt = _totalDebt.add(performanceFee);
        emit ProfitReported(profit, performanceFee);
    }

    function reportLoss(uint256 loss) external override onlyStrategy {
        _strategyUnderlying = _strategyUnderlying.sub(loss);
        emit LossReported(loss);
    }

    function proposeStrategyUpdate(address newStrategy) external onlyOwner {
        require(newStrategy != strategy);
        proposedStrategy = newStrategy;
        _proposedStrategyTimestamp = block.timestamp;
        emit StrategyUpdateProposed(
            newStrategy,
            block.timestamp + STRATEGY_UPDATE_MIN_DELAY,
            block.timestamp + STRATEGY_UPDATE_MAX_DELAY
        );
    }

    function applyStrategyUpdate(address newStrategy) external onlyOwner {
        require(proposedStrategy == newStrategy, "Proposed strategy mismatch");
        require(
            block.timestamp >= _proposedStrategyTimestamp + STRATEGY_UPDATE_MIN_DELAY &&
                block.timestamp < _proposedStrategyTimestamp + STRATEGY_UPDATE_MAX_DELAY,
            "Not ready to update strategy"
        );
        require(_totalDebt == 0, "Cannot update strategy with debt");
        emit StrategyUpdated(strategy, newStrategy);
        strategy = newStrategy;
        proposedStrategy = address(0);
        _proposedStrategyTimestamp = 0;
    }

    function addObsoletePrimaryMarket(address obsoletePrimaryMarket) external onlyOwner {
        require(isPrimaryMarket(obsoletePrimaryMarket), "The address is not a primary market");
        obsoletePrimaryMarkets.push(obsoletePrimaryMarket);
        emit ObsoletePrimaryMarketAdded(obsoletePrimaryMarket);
    }

    function addNewPrimaryMarket(address newPrimaryMarket) external onlyOwner {
        require(!isPrimaryMarket(newPrimaryMarket), "The address is already a primary market");
        newPrimaryMarkets.push(newPrimaryMarket);
        emit NewPrimaryMarketAdded(newPrimaryMarket);
    }

    function updateDailyProtocolFeeRate(uint256 newDailyProtocolFeeRate) external onlyOwner {
        require(
            newDailyProtocolFeeRate <= MAX_DAILY_PROTOCOL_FEE_RATE,
            "Exceed max protocol fee rate"
        );
        dailyProtocolFeeRate = newDailyProtocolFeeRate;
        emit DailyProtocolFeeRateUpdated(newDailyProtocolFeeRate);
    }

    function updateTwapOracle(address newTwapOracle) external onlyOwner {
        twapOracle = ITwapOracle(newTwapOracle);
        emit TwapOracleUpdated(newTwapOracle);
    }

    function updateAprOracle(address newAprOracle) external onlyOwner {
        aprOracle = IAprOracle(newAprOracle);
        emit AprOracleUpdated(newAprOracle);
    }

    function updateBallot(address newBallot) external onlyOwner {
        ballot = IBallot(newBallot);
        emit BallotUpdated(newBallot);
    }

    function updateFeeCollector(address newFeeCollector) external onlyOwner {
        feeCollector = newFeeCollector;
        emit FeeCollectorUpdated(newFeeCollector);
    }

    function updateActivityDelayTime(uint256 delayTime) external onlyOwner {
        require(
            delayTime >= 30 minutes && delayTime <= 12 hours,
            "Exceed allowed delay time range"
        );
        activityDelayTimeAfterRebalance = delayTime;
        emit ActivityDelayTimeUpdated(delayTime);
    }

    /// @dev Transfer protocol fee of the current trading day to the fee collector.
    ///      This function should be called before creation and redemption on the same day
    ///      are settled.
    function _collectFee() private {
        uint256 currentUnderlying = getTotalUnderlying();
        uint256 fee = currentUnderlying.multiplyDecimal(dailyProtocolFeeRate);
        if (fee > 0) {
            feeDebt = feeDebt.add(fee);
            _totalDebt = _totalDebt.add(fee);
        }
    }

    /// @dev Settle primary market operations in every PrimaryMarket contract.
    function _settlePrimaryMarkets(uint256 day, uint256 price) private {
        uint256 day_ = day; // Fix the "stack too deep" error
        uint256 totalShares = getTotalShares();
        uint256 underlying = getTotalUnderlying();
        uint256 primaryMarketCount = getPrimaryMarketCount();
        uint256 prevNavM = _historicalNavs[day - 1 days][TRANCHE_M];
        uint256 newTotalDebt = _totalDebt;
        for (uint256 i = 0; i < primaryMarketCount; i++) {
            uint256 price_ = price; // Fix the "stack too deep" error
            IPrimaryMarketV2 pm = IPrimaryMarketV2(getPrimaryMarketMember(i));
            (
                uint256 sharesToMint,
                uint256 sharesToBurn,
                uint256 creationUnderlying,
                uint256 redemptionUnderlying,
                uint256 fee
            ) = pm.settle(day_, totalShares, underlying, price_, prevNavM);
            if (sharesToMint > sharesToBurn) {
                _mint(TRANCHE_M, address(pm), sharesToMint - sharesToBurn);
            } else if (sharesToBurn > sharesToMint) {
                _burn(TRANCHE_M, address(pm), sharesToBurn - sharesToMint);
            }
            uint256 debt = redemptionDebts[address(pm)];
            uint256 redemptionAndDebt = redemptionUnderlying.add(debt);
            if (creationUnderlying > redemptionAndDebt) {
                IERC20(tokenUnderlying).safeTransferFrom(
                    address(pm),
                    address(this),
                    creationUnderlying - redemptionAndDebt
                );
                redemptionDebts[address(pm)] = 0;
                newTotalDebt -= debt;
            } else {
                uint256 newDebt = redemptionAndDebt - creationUnderlying;
                redemptionDebts[address(pm)] = newDebt;
                newTotalDebt = newTotalDebt.sub(debt).add(newDebt);
            }
            if (fee > 0) {
                feeDebt = feeDebt.add(fee);
                newTotalDebt = newTotalDebt.add(fee);
            }
        }
        _totalDebt = newTotalDebt;
    }

    function _payDebt() private {
        uint256 total = _totalDebt;
        if (total == 0) {
            return;
        }
        uint256 hot = IERC20(tokenUnderlying).balanceOf(address(this));
        if (hot == 0) {
            return;
        }
        uint256 fee = feeDebt;
        if (fee > 0) {
            uint256 amount = hot.min(fee);
            feeDebt = fee - amount;
            total -= amount;
            hot -= amount;
            IERC20(tokenUnderlying).safeTransfer(feeCollector, amount);
        }
        uint256 primaryMarketCount = getPrimaryMarketCount();
        for (uint256 i = 0; i < primaryMarketCount && hot > 0 && total > 0; i++) {
            address pm = getPrimaryMarketMember(i);
            uint256 redemption = redemptionDebts[pm];
            if (redemption > 0) {
                uint256 amount = hot.min(redemption);
                redemptionDebts[pm] = redemption - amount;
                total -= amount;
                hot -= amount;
                IERC20(tokenUnderlying).safeTransfer(pm, amount);
                IPrimaryMarketV2(pm).updateDelayedRedemptionDay();
            }
        }
        _totalDebt = total;
    }

    /// @dev Check whether a new rebalance should be triggered. Rebalance is triggered if
    ///      NAV of Token B over NAV of Token A is greater than the upper threshold or
    ///      less than the lower threshold.
    /// @param navA NAV of Token A before the rebalance
    /// @param navBOrZero NAV of Token B before the rebalance or zero if the NAV is negative
    /// @return Whether a new rebalance should be triggered
    function _shouldTriggerRebalance(uint256 navA, uint256 navBOrZero) private view returns (bool) {
        uint256 bOverA = navBOrZero.divideDecimal(navA);
        return bOverA < lowerRebalanceThreshold || bOverA > upperRebalanceThreshold;
    }

    /// @dev Create a new rebalance that resets NAV of all tranches to 1. Total supplies are
    ///      rebalanced immediately.
    /// @param day Trading day that triggers this rebalance
    /// @param navM NAV of Token M before this rebalance
    /// @param navA NAV of Token A before this rebalance
    /// @param navBOrZero NAV of Token B before this rebalance or zero if the NAV is negative
    function _triggerRebalance(
        uint256 day,
        uint256 navM,
        uint256 navA,
        uint256 navBOrZero
    ) private {
        Rebalance memory rebalance = _calculateRebalance(navM, navA, navBOrZero);
        uint256 oldSize = _rebalanceSize;
        _rebalances[oldSize] = rebalance;
        _rebalanceSize = oldSize + 1;
        emit RebalanceTriggered(
            oldSize,
            day,
            rebalance.ratioM,
            rebalance.ratioA2M,
            rebalance.ratioB2M,
            rebalance.ratioAB
        );

        (
            _totalSupplies[TRANCHE_M],
            _totalSupplies[TRANCHE_A],
            _totalSupplies[TRANCHE_B]
        ) = doRebalance(
            _totalSupplies[TRANCHE_M],
            _totalSupplies[TRANCHE_A],
            _totalSupplies[TRANCHE_B],
            oldSize
        );
        _refreshBalance(address(this), oldSize + 1);
    }

    /// @dev Create a new rebalance matrix that resets given NAVs to (1, 1, 1).
    ///
    ///      Note that NAV of Token B can be negative before the rebalance when the underlying price
    ///      drops dramatically in a single trading day, in which case zero should be passed to
    ///      this function instead of the negative NAV.
    /// @param navM NAV of Token M before the rebalance
    /// @param navA NAV of Token A before the rebalance
    /// @param navBOrZero NAV of Token B before the rebalance or zero if the NAV is negative
    /// @return The rebalance matrix
    function _calculateRebalance(
        uint256 navM,
        uint256 navA,
        uint256 navBOrZero
    ) private view returns (Rebalance memory) {
        uint256 ratioAB;
        uint256 ratioA2M;
        uint256 ratioB2M;
        if (navBOrZero <= navA) {
            // Lower rebalance
            ratioAB = navBOrZero;
            ratioA2M = ((navM - navBOrZero) * WEIGHT_M) / WEIGHT_A;
            ratioB2M = 0;
        } else {
            // Upper rebalance
            ratioAB = UNIT;
            ratioA2M = navA - UNIT;
            ratioB2M = navBOrZero - UNIT;
        }
        return
            Rebalance({
                ratioM: navM,
                ratioA2M: ratioA2M,
                ratioB2M: ratioB2M,
                ratioAB: ratioAB,
                timestamp: block.timestamp
            });
    }

    function _updateInterestRate(uint256 week) private returns (uint256) {
        uint256 baseInterestRate = MAX_INTEREST_RATE.min(aprOracle.capture());
        uint256 floatingInterestRate = ballot.count(week).div(365);
        uint256 rate = baseInterestRate.add(floatingInterestRate);

        emit InterestRateUpdated(baseInterestRate, floatingInterestRate);

        return rate;
    }

    /// @dev Transform share balance to a given rebalance version, or to the latest version
    ///      if `targetVersion` is zero. This function does no bound check on `targetVersion`.
    /// @param account Account of the balance to rebalance
    /// @param targetVersion The target rebalance version, or zero for the latest version
    function _refreshBalance(address account, uint256 targetVersion) private {
        if (targetVersion == 0) {
            targetVersion = _rebalanceSize;
        }
        uint256 oldVersion = _balanceVersions[account];
        if (oldVersion >= targetVersion) {
            return;
        }

        uint256[TRANCHE_COUNT] storage balanceTuple = _balances[account];
        uint256 balanceM = balanceTuple[TRANCHE_M];
        uint256 balanceA = balanceTuple[TRANCHE_A];
        uint256 balanceB = balanceTuple[TRANCHE_B];
        _balanceVersions[account] = targetVersion;

        if (balanceM == 0 && balanceA == 0 && balanceB == 0) {
            // Fast path for an empty account
            return;
        }

        for (uint256 i = oldVersion; i < targetVersion; i++) {
            (balanceM, balanceA, balanceB) = doRebalance(balanceM, balanceA, balanceB, i);
        }
        balanceTuple[TRANCHE_M] = balanceM;
        balanceTuple[TRANCHE_A] = balanceA;
        balanceTuple[TRANCHE_B] = balanceB;

        emit BalancesRebalanced(account, targetVersion, balanceM, balanceA, balanceB);
    }

    /// @dev Transform allowance to a given rebalance version, or to the latest version
    ///      if `targetVersion` is zero. This function does no bound check on `targetVersion`.
    /// @param owner Owner of the allowance to rebalance
    /// @param spender Spender of the allowance to rebalance
    /// @param targetVersion The target rebalance version, or zero for the latest version
    function _refreshAllowance(
        address owner,
        address spender,
        uint256 targetVersion
    ) private {
        if (targetVersion == 0) {
            targetVersion = _rebalanceSize;
        }
        uint256 oldVersion = _allowanceVersions[owner][spender];
        if (oldVersion >= targetVersion) {
            return;
        }

        uint256[TRANCHE_COUNT] storage allowanceTuple = _allowances[owner][spender];
        uint256 allowanceM = allowanceTuple[TRANCHE_M];
        uint256 allowanceA = allowanceTuple[TRANCHE_A];
        uint256 allowanceB = allowanceTuple[TRANCHE_B];
        _allowanceVersions[owner][spender] = targetVersion;

        if (allowanceM == 0 && allowanceA == 0 && allowanceB == 0) {
            // Fast path for an empty allowance
            return;
        }

        for (uint256 i = oldVersion; i < targetVersion; i++) {
            (allowanceM, allowanceA, allowanceB) = _rebalanceAllowance(
                allowanceM,
                allowanceA,
                allowanceB,
                i
            );
        }
        allowanceTuple[TRANCHE_M] = allowanceM;
        allowanceTuple[TRANCHE_A] = allowanceA;
        allowanceTuple[TRANCHE_B] = allowanceB;

        emit AllowancesRebalanced(
            owner,
            spender,
            targetVersion,
            allowanceM,
            allowanceA,
            allowanceB
        );
    }

    function _rebalanceAllowance(
        uint256 allowanceM,
        uint256 allowanceA,
        uint256 allowanceB,
        uint256 index
    )
        private
        view
        returns (
            uint256 newAllowanceM,
            uint256 newAllowanceA,
            uint256 newAllowanceB
        )
    {
        Rebalance storage rebalance = _rebalances[index];

        /// @dev using saturating arithmetic to avoid unconscious overflow revert
        newAllowanceM = allowanceM.saturatingMultiplyDecimal(rebalance.ratioM);
        newAllowanceA = allowanceA.saturatingMultiplyDecimal(rebalance.ratioAB);
        newAllowanceB = allowanceB.saturatingMultiplyDecimal(rebalance.ratioAB);
    }
}
