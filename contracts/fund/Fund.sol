// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/CoreUtility.sol";

import "../interfaces/IPrimaryMarket.sol";
import "../interfaces/IFund.sol";
import "../interfaces/ITwapOracle.sol";
import "../interfaces/IAprOracle.sol";
import "../interfaces/IBallot.sol";
import "../interfaces/IVotingEscrow.sol";
import "../interfaces/ITrancheIndex.sol";

import "./FundRoles.sol";

contract Fund is IFund, Ownable, ReentrancyGuard, FundRoles, CoreUtility, ITrancheIndex {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 private constant UNIT = 1e18;
    uint256 private constant MAX_INTEREST_RATE = 0.5e18; // 50% APR

    uint256 private constant WEIGHT_A = 1;
    uint256 private constant WEIGHT_B = 1;
    uint256 private constant WEIGHT_M = WEIGHT_A + WEIGHT_B;

    /// @notice Daily management fee rate.
    uint256 public dailyManagementFeeRate;

    /// @notice NAV threshold of Token M for a upper conversion.
    uint256 public upperConversionThreshold;

    /// @notice NAV threshold of Token B for a lower conversion.
    uint256 public lowerConversionThreshold;

    /// @notice NAV threshold of Token A for a fixed conversion.
    uint256 public fixedConversionThreshold;

    /// @notice TwapOracle address for the underlying asset.
    ITwapOracle public override twapOracle;

    /// @notice Governance address.
    address public override governance;

    /// @notice AprOracle address.
    IAprOracle public aprOracle;

    // Ballot
    IBallot public ballot;

    /// @notice Address of the underlying token.
    address public override tokenUnderlying;

    /// @notice Address of Token M.
    address public override tokenM;

    /// @notice Address of Token A.
    address public override tokenA;

    /// @notice Address of Token B.
    address public override tokenB;

    /// @notice A multipler that normalizes an underlying balance to 18 decimal places.
    uint256 public override underlyingDecimalMultiplier;

    /// @notice End timestamp of the current trading day.
    ///         A trading day starts at UTC time `SETTLEMENT_TIME` of a day (inclusive)
    ///         and ends at the same time of the next day (exclusive).
    uint256 public override currentDay;

    /// @notice Start timestamp of the current primary market activity window.
    uint256 public override fundActivityStartTime;

    /// @notice Start timestamp of the current exchange activity window.
    uint256 public override exchangeActivityStartTime;

    /// @dev History conversions. Conversions are often accessed in loops with bounds checking.
    ///      So we store them in a fixed-length array, in order to make compiler-generated
    ///      bounds checking on every access cheaper. Actual length of this array is stored in
    ///      `_conversionSize` and should be explicitly checked when necessary.
    Conversion[65535] private _conversions;

    /// @dev History conversion count.
    uint256 private _conversionSize;

    /// @dev Total share supply of the three tranches. They are always converted to the latest
    ///      version.
    uint256[TRANCHE_COUNT] private _totalSupplies;

    /// @dev Mapping of account => share balance of the three tranches.
    ///      Conversion versions are stored in a separate mapping `_balanceVersions`.
    mapping(address => uint256[TRANCHE_COUNT]) private _balances;

    /// @dev Conversion version mapping for `_balances`.
    mapping(address => uint256) private _balanceVersions;

    /// @dev Mapping of owner => spender => share allowance of the three tranches.
    ///      Conversion versions are stored in a separate mapping `_allowanceVersions`.
    mapping(address => mapping(address => uint256[TRANCHE_COUNT])) private _allowances;

    /// @dev Conversion version mapping for `_allowances`.
    mapping(address => mapping(address => uint256)) private _allowanceVersions;

    /// @dev Mapping of trading day => NAV tuple.
    mapping(uint256 => uint256[TRANCHE_COUNT]) private _historyNavs;

    /// @notice Mapping of trading day => total fund shares.
    ///
    ///         Key is the end timestamp of a trading day. Value is the total fund shares after
    ///         settlement of that trading day, as if all Token A and B are merged.
    mapping(uint256 => uint256) public historyTotalShares;

    /// @notice Mapping of trading day => underlying assets in the fund.
    ///
    ///         Key is the end timestamp of a trading day. Value is the underlying assets in
    ///         the fund after settlement of that trading day.
    mapping(uint256 => uint256) public historyUnderlying;

    /// @notice Mapping of trading week => interest rate of Token A.
    ///
    ///         Key is the end timestamp of a trading week. Value is the interest rate captured
    ///         after settlement of the first day of the trading week.
    mapping(uint256 => uint256) public historyInterestRate;

    address[] private obsoletePrimaryMarkets;
    address[] private newPrimaryMarkets;

    constructor(
        uint256 dailyManagementFeeRate_,
        uint256 upperConversionThreshold_,
        uint256 lowerConversionThreshold_,
        uint256 fixedConversionThreshold_,
        address twapOracle_
    ) public Ownable() FundRoles() {
        dailyManagementFeeRate = dailyManagementFeeRate_;
        upperConversionThreshold = upperConversionThreshold_;
        lowerConversionThreshold = lowerConversionThreshold_;
        fixedConversionThreshold = fixedConversionThreshold_;
        twapOracle = ITwapOracle(twapOracle_);
        currentDay = endOfDay(block.timestamp);
        fundActivityStartTime = endOfDay(block.timestamp) - 1 days;
        exchangeActivityStartTime = endOfDay(block.timestamp) - 1 days + 30 minutes;
    }

    function initialize(
        address tokenUnderlying_,
        uint256 underlyingDecimals_,
        address tokenM_,
        address tokenA_,
        address tokenB_,
        address aprOracle_,
        address ballot_,
        address primaryMarket_,
        address governance_
    ) external onlyOwner {
        require(tokenUnderlying == address(0), "already initialized");
        require(tokenUnderlying_ != address(0), "Underlying token address cannot be zero");
        tokenUnderlying = tokenUnderlying_;
        tokenM = tokenM_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        ballot = IBallot(ballot_);
        aprOracle = IAprOracle(aprOracle_);
        governance = governance_;

        require(underlyingDecimals_ <= 18, "Underlying decimals larger than 18");
        underlyingDecimalMultiplier = 10**(18 - underlyingDecimals_);

        _initializeRoles(tokenM_, tokenA_, tokenB_, primaryMarket_);

        uint256 lastDay = currentDay - 1 days;
        uint256 currentPrice = twapOracle.getTwap(lastDay);
        require(currentPrice != 0, "price n/a");
        _historyNavs[lastDay][TRANCHE_M] = UNIT;
        _historyNavs[lastDay][TRANCHE_A] = UNIT;
        _historyNavs[lastDay][TRANCHE_B] = UNIT;

        historyInterestRate[endOfWeek(currentDay - 1 days)] = MAX_INTEREST_RATE.min(
            aprOracle.capture()
        );
    }

    /// @notice Return weights of Token A and B when splitting Token M.
    /// @return weightA Weight of Token A
    /// @return weightB Weight of Token B
    function trancheWeights() external pure override returns (uint256 weightA, uint256 weightB) {
        return (WEIGHT_A, WEIGHT_B);
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

    // ---------------------------------
    /// @notice Return the status of the fund contract.
    /// @param timestamp Timestamp to assess
    /// @return True if the fund contract is active
    function isFundActive(uint256 timestamp) public view override returns (bool) {
        return (timestamp >= fundActivityStartTime && timestamp < currentDay);
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
        return (isPrimaryMarket(primaryMarket) && isFundActive(timestamp));
    }

    /// @notice Return the status of the exchange. Unlike the primary market, exchange is
    ///         anonymous to fund
    /// @param timestamp Timestamp to assess
    /// @return True if the exchange contract is active
    function isExchangeActive(uint256 timestamp) public view override returns (bool) {
        return (timestamp >= exchangeActivityStartTime && timestamp < (currentDay - 60 minutes));
    }

    /// @notice Total shares of the fund, as if all Token A and B are merged.
    function getTotalShares() public view override returns (uint256) {
        return
            _totalSupplies[TRANCHE_M].add(_totalSupplies[TRANCHE_A]).add(_totalSupplies[TRANCHE_B]);
    }

    /// @notice Return the conversion matrix at a given index. A zero struct is returned
    ///         if `index` is out of bound.
    /// @param index Conversion index
    /// @return A conversion
    function getConversion(uint256 index) external view override returns (Conversion memory) {
        return _conversions[index];
    }

    /// @notice Return trading day triggering a conversion at a given index. Zero is returned
    ///         if `index` is out of bound.
    /// @param index Conversion index
    /// @return Timestamp of the conversion
    function getConversionTimestamp(uint256 index) external view override returns (uint256) {
        return _conversions[index].timestamp;
    }

    /// @notice Return the number of conversions.
    function getConversionSize() external view override returns (uint256) {
        return _conversionSize;
    }

    /// @notice Return NAV of Token M, A and B of the given trading day.
    /// @param day End timestamp of a trading day
    /// @return NAV of Token M, A and B
    function historyNavs(uint256 day)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return (
            _historyNavs[day][TRANCHE_M],
            _historyNavs[day][TRANCHE_A],
            _historyNavs[day][TRANCHE_B]
        );
    }

    /// @notice Estimate NAV of all tranches at a given timestamp, considering underlying price
    ///         change, accrued management fee and accrued interest since the previous settlement.
    ///
    ///         The extrapolation uses simple interest instead of daily compound interest in
    ///         calculating management fee and Token A's interest. There may be significant error
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
        uint256 previousShares = historyTotalShares[previousDay];
        uint256 navM = _extrapolateNavM(previousDay, previousShares, timestamp, price);
        uint256 navA = _extrapolateNavA(previousDay, previousShares, timestamp);
        uint256 navB = calculateNavB(navM, navA);
        return (navM, navA, navB);
    }

    /// @notice Estimate NAV of Token M at a given timestamp, considering underlying price
    ///         change and accrued management fee since the previous settlement.
    ///
    ///         The extrapolation uses simple interest instead of daily compound interest in
    ///         calculating management fee and Token A's interest. There may be significant error
    ///         in the returned value when `timestamp` is far beyond the last settlement.
    /// @param timestamp Timestamp to estimate
    /// @param price Price of the underlying asset (18 decimal places)
    /// @return Estimated NAV of Token M
    function extrapolateNavM(uint256 timestamp, uint256 price)
        external
        view
        override
        returns (uint256)
    {
        // Find the last settled trading day before the given timestamp.
        uint256 previousDay = currentDay - 1 days;
        if (previousDay > timestamp) {
            previousDay = endOfDay(timestamp) - 1 days;
        }
        uint256 previousShares = historyTotalShares[previousDay];
        return _extrapolateNavM(previousDay, previousShares, timestamp, price);
    }

    /// @notice Estimate NAV of Token A at a given timestamp, considering accrued interest
    ///         since the previous settlement.
    ///
    ///         The extrapolation uses simple interest instead of daily compound interest in
    ///         calculating management fee and Token A's interest. There may be significant error
    ///         in the returned value when `timestamp` is far beyond the last settlement.
    /// @param timestamp Timestamp to estimate
    /// @return Estimated NAV of Token A
    function extrapolateNavA(uint256 timestamp) external view override returns (uint256) {
        // Find the last settled trading day before the given timestamp.
        uint256 previousDay = currentDay - 1 days;
        if (previousDay > timestamp) {
            previousDay = endOfDay(timestamp) - 1 days;
        }
        uint256 previousShares = historyTotalShares[previousDay];
        return _extrapolateNavA(previousDay, previousShares, timestamp);
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
            navM = _historyNavs[previousDay][TRANCHE_M];
            if (navM == 0) {
                // No NAV is recorded because the given timestamp is before the fund launches.
                return UNIT;
            } else {
                return navM;
            }
        }
        uint256 totalValue =
            price.mul(historyUnderlying[previousDay].mul(underlyingDecimalMultiplier));
        uint256 accruedFee =
            totalValue.multiplyDecimal(dailyManagementFeeRate).mul(timestamp - previousDay).div(
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
        uint256 navA = _historyNavs[previousDay][TRANCHE_A];
        if (previousShares == 0) {
            // The fund is empty. Just return the previous recorded NAV.
            if (navA == 0) {
                // No NAV is recorded because the given timestamp is before the fund launches.
                return UNIT;
            } else {
                return navA;
            }
        }

        uint256 week = endOfWeek(previousDay);
        uint256 newNavA =
            navA
                .multiplyDecimal(
                UNIT.sub(dailyManagementFeeRate.mul(timestamp - previousDay).div(1 days))
            )
                .multiplyDecimal(
                UNIT.add(historyInterestRate[week].mul(timestamp - previousDay).div(1 days))
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

    /// @notice Transform share amounts according to the conversion at a given index.
    ///         This function performs no bounds checking on the given index. A non-existent
    ///         conversion transforms anything to a zero vector.
    /// @param amountM Amount of Token M before conversion
    /// @param amountA Amount of Token A before conversion
    /// @param amountB Amount of Token B before conversion
    /// @param index Conversion index
    /// @return newAmountM Amount of Token M after conversion
    /// @return newAmountA Amount of Token A after conversion
    /// @return newAmountB Amount of Token B after conversion
    function convert(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 index
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
        return _convert(amountM, amountA, amountB, index);
    }

    /// @notice Transform share amounts according to conversions in a given index range,
    ///         This function performs no bounds checking on the given indices. The original amounts
    ///         are returned if `fromIndex` is no less than `toIndex`. A zero vector is returned
    ///         if `toIndex` is greater than the number of existing conversions.
    /// @param amountM Amount of Token M before conversion
    /// @param amountA Amount of Token A before conversion
    /// @param amountB Amount of Token B before conversion
    /// @param fromIndex Starting of the conversion index range, inclusive
    /// @param toIndex End of the conversion index range, exclusive
    /// @return newAmountM Amount of Token M after conversion
    /// @return newAmountA Amount of Token A after conversion
    /// @return newAmountB Amount of Token B after conversion
    function batchConvert(
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
            (amountM, amountA, amountB) = _convert(amountM, amountA, amountB, i);
        }
        newAmountM = amountM;
        newAmountA = amountA;
        newAmountB = amountB;
    }

    /// @notice Transform share balance to a given conversion, or to the latest conversion
    ///         if `targetVersion` is zero.
    /// @param account Account of the balance to convert
    /// @param targetVersion Index beyond the last conversion in this transformation,
    ///                      or zero for the latest version
    function refreshBalance(address account, uint256 targetVersion) external override {
        if (targetVersion > 0) {
            require(targetVersion <= _conversionSize, "Target version out of bound");
        }
        _refreshBalance(account, targetVersion);
    }

    /// @notice Transform allowance to a given conversion, or to the latest conversion
    ///         if `targetVersion` is zero.
    /// @param owner Owner of the allowance to convert
    /// @param spender Spender of the allowance to convert
    /// @param targetVersion Index beyond the last conversion in this transformation,
    ///                      or zero for the latest version
    function refreshAllowance(
        address owner,
        address spender,
        uint256 targetVersion
    ) external override {
        if (targetVersion > 0) {
            require(targetVersion <= _conversionSize, "Target version out of bound");
        }
        _refreshAllowance(owner, spender, targetVersion);
    }

    function shareBalanceOf(uint256 tranche, address account)
        public
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

        uint256 size = _conversionSize; // Gas saver
        for (uint256 i = _balanceVersions[account]; i < size; i++) {
            (amountM, amountA, amountB) = _convert(amountM, amountA, amountB, i);
        }

        if (tranche == TRANCHE_M) {
            return amountM;
        } else if (tranche == TRANCHE_A) {
            return amountA;
        } else {
            return amountB;
        }
    }

    /// @notice Return all three share balances to the latest conversion
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

        uint256 size = _conversionSize; // Gas saver
        for (uint256 i = _balanceVersions[account]; i < size; i++) {
            (amountM, amountA, amountB) = _convert(amountM, amountA, amountB, i);
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
    ) public view override returns (uint256) {
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

        uint256 size = _conversionSize; // Gas saver
        for (uint256 i = _allowanceVersions[owner][spender]; i < size; i++) {
            (allowanceM, allowanceA, allowanceB) = _convertAllowance(
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

    function shareTotalSupply(uint256 tranche) public view override returns (uint256) {
        return _totalSupplies[tranche];
    }

    function mint(
        uint256 tranche,
        address account,
        uint256 amount
    ) public override onlyPrimaryMarket {
        _refreshBalance(account, _conversionSize);
        _mint(tranche, account, amount);
    }

    function burn(
        uint256 tranche,
        address account,
        uint256 amount
    ) public override onlyPrimaryMarket {
        _refreshBalance(account, _conversionSize);
        _burn(tranche, account, amount);
    }

    function transfer(
        uint256 tranche,
        address sender,
        address recipient,
        uint256 amount
    ) public override onlyShare {
        require(isFundActive(block.timestamp), "Transfer is inactive");
        _refreshBalance(sender, _conversionSize);
        _refreshBalance(recipient, _conversionSize);
        _transfer(tranche, sender, recipient, amount);
    }

    function transferFrom(
        uint256 tranche,
        address spender,
        address sender,
        address recipient,
        uint256 amount
    ) public override onlyShare returns (uint256 newAllowance) {
        transfer(tranche, sender, recipient, amount);

        _refreshAllowance(sender, spender, _conversionSize);
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
    ) public override onlyShare {
        _refreshAllowance(owner, spender, _conversionSize);
        _approve(tranche, owner, spender, amount);
    }

    function increaseAllowance(
        uint256 tranche,
        address sender,
        address spender,
        uint256 addedValue
    ) public override onlyShare returns (uint256 newAllowance) {
        _refreshAllowance(sender, spender, _conversionSize);
        newAllowance = _allowances[sender][spender][tranche].add(addedValue);
        _approve(tranche, sender, spender, newAllowance);
    }

    function decreaseAllowance(
        uint256 tranche,
        address sender,
        address spender,
        uint256 subtractedValue
    ) public override onlyShare returns (uint256 newAllowance) {
        _refreshAllowance(sender, spender, _conversionSize);
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
    }

    function _mint(
        uint256 tranche,
        address account,
        uint256 amount
    ) private {
        require(account != address(0), "ERC20: mint to the zero address");

        _totalSupplies[tranche] = _totalSupplies[tranche].add(amount);
        _balances[account][tranche] = _balances[account][tranche].add(amount);
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
    }

    /// @notice Settle the current trading day. Settlement includes the following changes
    ///         to the fund.
    ///
    ///         1. Transfer management fee of the day to the governance address.
    ///         2. Settle all pending creations and redemptions from all primary markets.
    ///         3. Calculate NAV of the day and trigger conversion if necessary.
    ///         4. Capture new interest rate for Token A.
    function settle() external nonReentrant {
        uint256 day = currentDay;
        uint256 currentWeek = endOfWeek(day - 1 days);
        require(block.timestamp >= day, "The current trading day does not end yet");
        uint256 price = twapOracle.getTwap(day);
        require(price != 0, "Underlying price for settlement is not ready yet");

        _collectFee();

        _settlePrimaryMarkets(day, price);

        // Calculate NAV
        uint256 totalShares = getTotalShares();
        uint256 underlying = IERC20(tokenUnderlying).balanceOf(address(this));
        uint256 navA = _historyNavs[day - 1 days][TRANCHE_A];
        uint256 navM;
        if (totalShares > 0) {
            navM = price.mul(underlying.mul(underlyingDecimalMultiplier)).div(totalShares);
            if (historyTotalShares[day - 1 days] > 0) {
                // Update NAV of Token A only when the fund is non-empty both before and after
                // this settlement
                uint256 newNavA =
                    navA.multiplyDecimal(UNIT.sub(dailyManagementFeeRate)).multiplyDecimal(
                        historyInterestRate[currentWeek].add(UNIT)
                    );
                if (navA < newNavA) {
                    navA = newNavA;
                }
            }
        } else {
            // If the fund is empty, use NAV of Token M in the last day
            navM = _historyNavs[day - 1 days][TRANCHE_M];
        }
        uint256 navB = calculateNavB(navM, navA);

        if (_shouldTriggerConversion(navM, navA, navB)) {
            _triggerConversion(day, navM, navA, navB);
            navM = UNIT;
            navA = UNIT;
            navB = UNIT;
            totalShares = getTotalShares();
            fundActivityStartTime = day + 12 hours;
            exchangeActivityStartTime = day + 12 hours;
        } else {
            fundActivityStartTime = day;
            exchangeActivityStartTime = day + 30 minutes;
        }

        if (currentDay == currentWeek) {
            historyInterestRate[currentWeek + 1 weeks] = _updateInterestRate(currentWeek);
        }

        historyTotalShares[day] = totalShares;
        historyUnderlying[day] = underlying;
        _historyNavs[day][TRANCHE_M] = navM;
        _historyNavs[day][TRANCHE_A] = navA;
        _historyNavs[day][TRANCHE_B] = navB;
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

    function addObsoletePrimaryMarket(address obsoletePrimaryMarket) external onlyOwner {
        require(isPrimaryMarket(obsoletePrimaryMarket), "The address is not a primary market");
        obsoletePrimaryMarkets.push(obsoletePrimaryMarket);
    }

    function addNewPrimaryMarket(address newPrimaryMarket) external onlyOwner {
        require(!isPrimaryMarket(newPrimaryMarket), "The address is already a primary market");
        newPrimaryMarkets.push(newPrimaryMarket);
    }

    /// @dev Transfer management fee of the current trading day to the governance address.
    ///      This function should be called before creation and redemption on the same day
    ///      are settled.
    function _collectFee() private {
        uint256 currentUnderlying = IERC20(tokenUnderlying).balanceOf(address(this));
        uint256 fee = currentUnderlying.multiplyDecimal(dailyManagementFeeRate);
        if (fee > 0) {
            require(
                IERC20(tokenUnderlying).transfer(address(governance), fee),
                "tokenUnderlying failed transfer"
            );
        }
    }

    /// @dev Settle primary market operations in every PrimaryMarket contract.
    function _settlePrimaryMarkets(uint256 day, uint256 price) private {
        uint256 totalShares = getTotalShares();
        uint256 underlying = IERC20(tokenUnderlying).balanceOf(address(this));
        uint256 prevNavM = _historyNavs[day - 1 days][TRANCHE_M];
        uint256 primaryMarketCount = getPrimaryMarketCount();
        for (uint256 i = 0; i < primaryMarketCount; i++) {
            uint256 price_ = price; // Fix the "stack too deep" error
            IPrimaryMarket pm = IPrimaryMarket(getPrimaryMarketMember(i));
            (
                uint256 sharesToMint,
                uint256 sharesToBurn,
                uint256 creationUnderlying,
                uint256 redemptionUnderlying,
                uint256 fee
            ) = pm.settle(day, totalShares, underlying, price_, prevNavM);
            if (sharesToMint > sharesToBurn) {
                _mint(TRANCHE_M, address(pm), sharesToMint - sharesToBurn);
            } else if (sharesToBurn > sharesToMint) {
                _burn(TRANCHE_M, address(pm), sharesToBurn - sharesToMint);
            }
            if (creationUnderlying > redemptionUnderlying) {
                require(
                    IERC20(tokenUnderlying).transferFrom(
                        address(pm),
                        address(this),
                        creationUnderlying - redemptionUnderlying
                    ),
                    "tokenUnderlying failed transferFrom"
                );
            } else if (redemptionUnderlying > creationUnderlying) {
                require(
                    IERC20(tokenUnderlying).transfer(
                        address(pm),
                        redemptionUnderlying - creationUnderlying
                    ),
                    "tokenUnderlying failed transfer"
                );
            }
            if (fee > 0) {
                require(
                    IERC20(tokenUnderlying).transfer(address(governance), fee),
                    "tokenUnderlying failed transferFrom"
                );
            }
        }
    }

    /// @dev Check whether a new conversion should be triggered. Conversion is triggered if
    ///      one of the following conditions is met:
    ///
    ///      1. NAV of Token M grows above a threshold.
    ///      2. NAV of Token B drops below a threshold.
    ///      3. NAV of Token A grows above a threshold.
    /// @param navM NAV of Token M before conversion
    /// @param navA NAV of Token A before conversion
    /// @param navBOrZero NAV of Token B before conversion or zero if the NAV is negative
    /// @return Whether a new conversion should be triggered
    function _shouldTriggerConversion(
        uint256 navM,
        uint256 navA,
        uint256 navBOrZero
    ) private view returns (bool) {
        return
            navM > upperConversionThreshold ||
            navBOrZero < lowerConversionThreshold ||
            navA > fixedConversionThreshold;
    }

    /// @dev Create a new conversion that converts NAV of all tranches to 1. Total supplies are
    ///      converted immediately.
    /// @param day Trading day that triggers this conversion
    /// @param navM NAV of Token M before conversion
    /// @param navA NAV of Token A before conversion
    /// @param navBOrZero NAV of Token B before conversion or zero if the NAV is negative
    function _triggerConversion(
        uint256 day,
        uint256 navM,
        uint256 navA,
        uint256 navBOrZero
    ) private {
        Conversion memory conversion = _calculateConversion(navM, navA, navBOrZero);
        uint256 oldSize = _conversionSize;
        _conversions[oldSize] = conversion;
        _conversionSize = oldSize + 1;
        emit ConversionTriggered(
            oldSize,
            day,
            conversion.ratioM,
            conversion.ratioA2M,
            conversion.ratioB2M,
            conversion.ratioAB
        );

        (
            _totalSupplies[TRANCHE_M],
            _totalSupplies[TRANCHE_A],
            _totalSupplies[TRANCHE_B]
        ) = _convert(
            _totalSupplies[TRANCHE_M],
            _totalSupplies[TRANCHE_A],
            _totalSupplies[TRANCHE_B],
            oldSize
        );
        _refreshBalance(address(this), oldSize + 1);
    }

    /// @dev Create a new conversion matrix that transforms given NAVs to (1, 1, 1).
    ///
    ///      Note that NAV of Token B can be negative before conversion when the underlying price
    ///      drops dramatically in a single trading day, in which case zero should be passed to
    ///      this function instead of the negative NAV.
    /// @param navM NAV of Token M before conversion
    /// @param navA NAV of Token A before conversion
    /// @param navBOrZero NAV of Token B before conversion or zero if the NAV is negative
    /// @return The conversion matrix
    function _calculateConversion(
        uint256 navM,
        uint256 navA,
        uint256 navBOrZero
    ) private view returns (Conversion memory) {
        uint256 ratioAB;
        uint256 ratioA2M;
        uint256 ratioB2M;
        if (navBOrZero <= navA) {
            // Lower conversion
            ratioAB = navBOrZero;
            ratioA2M = ((navM - navBOrZero) * WEIGHT_M) / WEIGHT_A;
            ratioB2M = 0;
        } else {
            // Upper conversion
            ratioAB = UNIT;
            ratioA2M = navA - UNIT;
            ratioB2M = navBOrZero - UNIT;
        }
        return
            Conversion({
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

    /// @dev Transform share balance to a given conversion, or to the latest conversion
    ///      if `targetVersion` is zero. This function does no bound check on `targetVersion`.
    /// @param account Account of the balance to convert
    /// @param targetVersion Index beyond the last conversion in this transformation,
    ///                      or zero for the latest version
    function _refreshBalance(address account, uint256 targetVersion) private {
        if (targetVersion == 0) {
            targetVersion = _conversionSize;
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
            (balanceM, balanceA, balanceB) = _convert(balanceM, balanceA, balanceB, i);
        }
        balanceTuple[TRANCHE_M] = balanceM;
        balanceTuple[TRANCHE_A] = balanceA;
        balanceTuple[TRANCHE_B] = balanceB;
    }

    /// @dev Transform allowance to a given conversion, or to the latest conversion
    ///      if `targetVersion` is zero. This function does no bound check on `targetVersion`.
    /// @param owner Owner of the allowance to convert
    /// @param spender Spender of the allowance to convert
    /// @param targetVersion Index beyond the last conversion in this transformation,
    ///                      or zero for the latest version
    function _refreshAllowance(
        address owner,
        address spender,
        uint256 targetVersion
    ) private {
        if (targetVersion == 0) {
            targetVersion = _conversionSize;
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
            // Fast path for an empty account
            return;
        }

        for (uint256 i = oldVersion; i < targetVersion; i++) {
            (allowanceM, allowanceA, allowanceB) = _convertAllowance(
                allowanceM,
                allowanceA,
                allowanceB,
                i
            );
        }
        allowanceTuple[TRANCHE_M] = allowanceM;
        allowanceTuple[TRANCHE_A] = allowanceA;
        allowanceTuple[TRANCHE_B] = allowanceB;
    }

    function _convert(
        uint256 amountM,
        uint256 amountA,
        uint256 amountB,
        uint256 index
    )
        private
        view
        returns (
            uint256 newAmountM,
            uint256 newAmountA,
            uint256 newAmountB
        )
    {
        Conversion storage conversion = _conversions[index];
        newAmountM = amountM
            .multiplyDecimal(conversion.ratioM)
            .add(amountA.multiplyDecimal(conversion.ratioA2M))
            .add(amountB.multiplyDecimal(conversion.ratioB2M));
        uint256 ratioAB = conversion.ratioAB; // Gas saver
        newAmountA = amountA.multiplyDecimal(ratioAB);
        newAmountB = amountB.multiplyDecimal(ratioAB);
    }

    function _convertAllowance(
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
        Conversion storage conversion = _conversions[index];

        /// @dev using saturating arithmetic to avoid unconscious overflow revert
        newAllowanceM = allowanceM.saturatingMultiplyDecimal(conversion.ratioM);
        newAllowanceA = allowanceA.saturatingMultiplyDecimal(conversion.ratioAB);
        newAllowanceB = allowanceB.saturatingMultiplyDecimal(conversion.ratioAB);
    }
}
