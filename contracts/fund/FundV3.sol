// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/CoreUtility.sol";

import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/IShareV2.sol";
import "../interfaces/ITwapOracleV2.sol";
import "../interfaces/IAprOracle.sol";
import "../interfaces/IBallot.sol";
import "../interfaces/IVotingEscrow.sol";

import "./FundRolesV2.sol";

contract FundV3 is IFundV3, Ownable, ReentrancyGuard, FundRolesV2, CoreUtility {
    using Math for uint256;
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

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
    event SplitRatioUpdated(uint256 newSplitRatio);
    event FeeDebtPaid(uint256 amount);

    uint256 private constant UNIT = 1e18;
    uint256 private constant MAX_INTEREST_RATE = 0.2e18; // 20% daily
    uint256 private constant MAX_DAILY_PROTOCOL_FEE_RATE = 0.05e18; // 5% daily rate

    uint256 private constant STRATEGY_UPDATE_MIN_DELAY = 3 days;
    uint256 private constant STRATEGY_UPDATE_MAX_DELAY = 7 days;

    /// @notice Upper bound of `NAV_R / NAV_B` to trigger a rebalance.
    uint256 public immutable upperRebalanceThreshold;

    /// @notice Lower bound of `NAV_R / NAV_B` to trigger a rebalance.
    uint256 public immutable lowerRebalanceThreshold;

    /// @notice Address of the underlying token.
    address public immutable override tokenUnderlying;

    /// @notice A multipler that normalizes an underlying balance to 18 decimal places.
    uint256 public immutable override underlyingDecimalMultiplier;

    /// @notice Daily protocol fee rate.
    uint256 public dailyProtocolFeeRate;

    /// @notice TwapOracle address for the underlying asset.
    ITwapOracleV2 public override twapOracle;

    /// @notice AprOracle address.
    IAprOracle public aprOracle;

    /// @notice Address of the interest rate ballot.
    IBallot public ballot;

    /// @notice Fee Collector address.
    address public override feeCollector;

    /// @notice End timestamp of the current trading day.
    ///         A trading day starts at UTC time `SETTLEMENT_TIME` of a day (inclusive)
    ///         and ends at the same time of the next day (exclusive).
    uint256 public override currentDay;

    /// @notice The amount of BISHOP received by splitting one QUEEN.
    ///         This ratio changes on every rebalance.
    uint256 public override splitRatio;

    /// @dev Mapping of rebalance version => splitRatio.
    mapping(uint256 => uint256) private _historicalSplitRatio;

    /// @notice Start timestamp of the current primary market activity window.
    uint256 public override fundActivityStartTime;

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

    /// @dev Mapping of trading day => NAV of BISHOP.
    mapping(uint256 => uint256) private _historicalNavB;

    /// @dev Mapping of trading day => NAV of ROOK.
    mapping(uint256 => uint256) private _historicalNavR;

    /// @notice Mapping of trading day => equivalent BISHOP supply.
    ///
    ///         Key is the end timestamp of a trading day. Value is the total supply of BISHOP,
    ///         as if all QUEEN are split.
    mapping(uint256 => uint256) public override historicalEquivalentTotalB;

    /// @notice Mapping of trading day => underlying assets in the fund.
    ///
    ///         Key is the end timestamp of a trading day. Value is the underlying assets in
    ///         the fund after settlement of that trading day.
    mapping(uint256 => uint256) public override historicalUnderlying;

    /// @notice Mapping of trading week => interest rate of BISHOP.
    ///
    ///         Key is the end timestamp of a trading day. Value is the interest rate captured
    ///         after settlement of that day, which will be effective in the following trading day.
    mapping(uint256 => uint256) public historicalInterestRate;

    /// @notice Amount of fee not transfered to the fee collector yet.
    uint256 public feeDebt;

    /// @notice Amount of redemption underlying that the fund owes the primary market
    uint256 public redemptionDebt;

    /// @dev Sum of the fee debt and redemption debts of all primary markets.
    uint256 private _totalDebt;

    uint256 private _strategyUnderlying;

    struct ConstructorParameters {
        address tokenUnderlying;
        uint256 underlyingDecimals;
        address tokenQ;
        address tokenB;
        address tokenR;
        address primaryMarket;
        address strategy;
        uint256 dailyProtocolFeeRate;
        uint256 upperRebalanceThreshold;
        uint256 lowerRebalanceThreshold;
        address twapOracle;
        address aprOracle;
        address ballot;
        address feeCollector;
    }

    constructor(ConstructorParameters memory params)
        public
        Ownable()
        FundRolesV2(
            params.tokenQ,
            params.tokenB,
            params.tokenR,
            params.primaryMarket,
            params.strategy
        )
    {
        tokenUnderlying = params.tokenUnderlying;
        require(params.underlyingDecimals <= 18, "Underlying decimals larger than 18");
        underlyingDecimalMultiplier = 10**(18 - params.underlyingDecimals);
        _updateDailyProtocolFeeRate(params.dailyProtocolFeeRate);
        upperRebalanceThreshold = params.upperRebalanceThreshold;
        lowerRebalanceThreshold = params.lowerRebalanceThreshold;
        _updateTwapOracle(params.twapOracle);
        _updateAprOracle(params.aprOracle);
        _updateBallot(params.ballot);
        _updateFeeCollector(params.feeCollector);
        _updateActivityDelayTime(30 minutes);
    }

    function initialize(
        uint256 newSplitRatio,
        uint256 lastNavB,
        uint256 lastNavR
    ) external onlyOwner {
        require(splitRatio == 0 && currentDay == 0, "Already initialized");
        require(
            newSplitRatio != 0 && lastNavB >= UNIT && !_shouldTriggerRebalance(lastNavB, lastNavR),
            "Invalid parameters"
        );
        currentDay = endOfDay(block.timestamp);
        splitRatio = newSplitRatio;
        _historicalSplitRatio[0] = newSplitRatio;
        emit SplitRatioUpdated(newSplitRatio);
        uint256 lastDay = currentDay - 1 days;
        uint256 lastDayPrice = twapOracle.getTwap(lastDay);
        require(lastDayPrice != 0, "Price not available"); // required to do the first creation
        _historicalNavB[lastDay] = lastNavB;
        _historicalNavR[lastDay] = lastNavR;
        historicalInterestRate[lastDay] = MAX_INTEREST_RATE.min(aprOracle.capture()); // XXX
        fundActivityStartTime = lastDay;
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

    function tokenQ() external view override returns (address) {
        return _tokenQ;
    }

    function tokenB() external view override returns (address) {
        return _tokenB;
    }

    function tokenR() external view override returns (address) {
        return _tokenR;
    }

    function tokenShare(uint256 tranche) external view override returns (address) {
        return _getShare(tranche);
    }

    function primaryMarket() external view override returns (address) {
        return _primaryMarket;
    }

    function primaryMarketUpdateProposal() external view override returns (address, uint256) {
        return (_proposedPrimaryMarket, _proposedPrimaryMarketTimestamp);
    }

    function strategy() external view override returns (address) {
        return _strategy;
    }

    function strategyUpdateProposal() external view override returns (address, uint256) {
        return (_proposedStrategy, _proposedStrategyTimestamp);
    }

    /// @notice Return the status of the fund contract.
    /// @param timestamp Timestamp to assess
    /// @return True if the fund contract is active
    function isFundActive(uint256 timestamp) public view override returns (bool) {
        return timestamp >= fundActivityStartTime;
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

    /// @notice Equivalent BISHOP supply, as if all QUEEN are split.
    function getEquivalentTotalB() public view override returns (uint256) {
        return _totalSupplies[TRANCHE_Q].multiplyDecimal(splitRatio).add(_totalSupplies[TRANCHE_B]);
    }

    /// @notice Equivalent QUEEN supply, as if all BISHOP and ROOK are merged.
    function getEquivalentTotalQ() external view override returns (uint256) {
        return
            _totalSupplies[TRANCHE_B]
                .add(_totalSupplies[TRANCHE_R])
                .divideDecimal(splitRatio)
                .div(2)
                .add(_totalSupplies[TRANCHE_Q]);
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

    /// @notice Return split ratio at a given version.
    ///         Zero is returned if `version` is invalid.
    /// @param version Rebalance version
    /// @return Split ratio of the version
    function historicalSplitRatio(uint256 version) external view override returns (uint256) {
        return _historicalSplitRatio[version];
    }

    /// @notice Return NAV of BISHOP and ROOK of the given trading day.
    /// @param day End timestamp of a trading day
    /// @return navB NAV of BISHOP
    /// @return navR NAV of ROOK
    function historicalNavs(uint256 day)
        external
        view
        override
        returns (uint256 navB, uint256 navR)
    {
        return (_historicalNavB[day], _historicalNavR[day]);
    }

    /// @notice Estimate the current NAV of all tranches, considering underlying price change,
    ///         accrued protocol fee and accrued interest since the previous settlement.
    ///
    ///         The extrapolation uses simple interest instead of daily compound interest in
    ///         calculating protocol fee and BISHOP's interest. There may be significant error
    ///         in the returned values when `timestamp` is far beyond the last settlement.
    /// @param price Price of the underlying asset (18 decimal places)
    /// @return navSum Sum of the estimated NAV of BISHOP and ROOK
    /// @return navB Estimated NAV of BISHOP
    /// @return navROrZero Estimated NAV of ROOK, or zero if the NAV is negative
    function extrapolateNav(uint256 price)
        external
        view
        override
        returns (
            uint256 navSum,
            uint256 navB,
            uint256 navROrZero
        )
    {
        uint256 settledDay = currentDay - 1 days;
        uint256 underlying = getTotalUnderlying();
        uint256 protocolFee =
            underlying.multiplyDecimal(dailyProtocolFeeRate).mul(block.timestamp - settledDay).div(
                1 days
            );
        underlying = underlying.sub(protocolFee);
        return
            _extrapolateNav(block.timestamp, settledDay, price, getEquivalentTotalB(), underlying);
    }

    function _extrapolateNav(
        uint256 timestamp,
        uint256 settledDay,
        uint256 price,
        uint256 equivalentTotalB,
        uint256 underlying
    )
        private
        view
        returns (
            uint256 navSum,
            uint256 navB,
            uint256 navROrZero
        )
    {
        navB = _historicalNavB[settledDay];
        if (equivalentTotalB > 0) {
            navSum = price.mul(underlying.mul(underlyingDecimalMultiplier)).div(equivalentTotalB);
            navB = navB.multiplyDecimal(
                historicalInterestRate[settledDay].mul(timestamp - settledDay).div(1 days).add(UNIT)
            );
            navROrZero = navSum >= navB ? navSum - navB : 0;
        } else {
            // If the fund is empty, use NAV in the last day
            navROrZero = _historicalNavR[settledDay];
            navSum = navB + navROrZero;
        }
    }

    /// @notice Transform share amounts according to the rebalance at a given index.
    ///         This function performs no bounds checking on the given index. A non-existent
    ///         rebalance transforms anything to a zero vector.
    /// @param amountQ Amount of QUEEN before the rebalance
    /// @param amountB Amount of BISHOP before the rebalance
    /// @param amountR Amount of ROOK before the rebalance
    /// @param index Rebalance index
    /// @return newAmountQ Amount of QUEEN after the rebalance
    /// @return newAmountB Amount of BISHOP after the rebalance
    /// @return newAmountR Amount of ROOK after the rebalance
    function doRebalance(
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR,
        uint256 index
    )
        public
        view
        override
        returns (
            uint256 newAmountQ,
            uint256 newAmountB,
            uint256 newAmountR
        )
    {
        Rebalance storage rebalance = _rebalances[index];
        newAmountQ = amountQ.add(amountB.multiplyDecimal(rebalance.ratioB2Q)).add(
            amountR.multiplyDecimal(rebalance.ratioR2Q)
        );
        uint256 ratioBR = rebalance.ratioBR; // Gas saver
        newAmountB = amountB.multiplyDecimal(ratioBR);
        newAmountR = amountR.multiplyDecimal(ratioBR);
    }

    /// @notice Transform share amounts according to rebalances in a given index range,
    ///         This function performs no bounds checking on the given indices. The original amounts
    ///         are returned if `fromIndex` is no less than `toIndex`. A zero vector is returned
    ///         if `toIndex` is greater than the number of existing rebalances.
    /// @param amountQ Amount of QUEEN before the rebalance
    /// @param amountB Amount of BISHOP before the rebalance
    /// @param amountR Amount of ROOK before the rebalance
    /// @param fromIndex Starting of the rebalance index range, inclusive
    /// @param toIndex End of the rebalance index range, exclusive
    /// @return newAmountQ Amount of QUEEN after the rebalance
    /// @return newAmountB Amount of BISHOP after the rebalance
    /// @return newAmountR Amount of ROOK after the rebalance
    function batchRebalance(
        uint256 amountQ,
        uint256 amountB,
        uint256 amountR,
        uint256 fromIndex,
        uint256 toIndex
    )
        external
        view
        override
        returns (
            uint256 newAmountQ,
            uint256 newAmountB,
            uint256 newAmountR
        )
    {
        for (uint256 i = fromIndex; i < toIndex; i++) {
            (amountQ, amountB, amountR) = doRebalance(amountQ, amountB, amountR, i);
        }
        newAmountQ = amountQ;
        newAmountB = amountB;
        newAmountR = amountR;
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

    function trancheBalanceOf(uint256 tranche, address account)
        external
        view
        override
        returns (uint256)
    {
        uint256 amountQ = _balances[account][TRANCHE_Q];
        uint256 amountB = _balances[account][TRANCHE_B];
        uint256 amountR = _balances[account][TRANCHE_R];

        if (tranche == TRANCHE_Q) {
            if (amountQ == 0 && amountB == 0 && amountR == 0) return 0;
        } else if (tranche == TRANCHE_B) {
            if (amountB == 0) return 0;
        } else {
            if (amountR == 0) return 0;
        }

        uint256 size = _rebalanceSize; // Gas saver
        for (uint256 i = _balanceVersions[account]; i < size; i++) {
            (amountQ, amountB, amountR) = doRebalance(amountQ, amountB, amountR, i);
        }

        if (tranche == TRANCHE_Q) {
            return amountQ;
        } else if (tranche == TRANCHE_B) {
            return amountB;
        } else {
            return amountR;
        }
    }

    /// @notice Return all three share balances transformed to the latest rebalance version.
    /// @param account Owner of the shares
    function trancheAllBalanceOf(address account)
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        uint256 amountQ = _balances[account][TRANCHE_Q];
        uint256 amountB = _balances[account][TRANCHE_B];
        uint256 amountR = _balances[account][TRANCHE_R];

        uint256 size = _rebalanceSize; // Gas saver
        for (uint256 i = _balanceVersions[account]; i < size; i++) {
            (amountQ, amountB, amountR) = doRebalance(amountQ, amountB, amountR, i);
        }

        return (amountQ, amountB, amountR);
    }

    function trancheBalanceVersion(address account) external view override returns (uint256) {
        return _balanceVersions[account];
    }

    function trancheAllowance(
        uint256 tranche,
        address owner,
        address spender
    ) external view override returns (uint256) {
        uint256 allowanceQ = _allowances[owner][spender][TRANCHE_Q];
        uint256 allowanceB = _allowances[owner][spender][TRANCHE_B];
        uint256 allowanceR = _allowances[owner][spender][TRANCHE_R];

        if (tranche == TRANCHE_Q) {
            if (allowanceQ == 0) return 0;
        } else if (tranche == TRANCHE_B) {
            if (allowanceB == 0) return 0;
        } else {
            if (allowanceR == 0) return 0;
        }

        uint256 size = _rebalanceSize; // Gas saver
        for (uint256 i = _allowanceVersions[owner][spender]; i < size; i++) {
            (allowanceQ, allowanceB, allowanceR) = _rebalanceAllowance(
                allowanceQ,
                allowanceB,
                allowanceR,
                i
            );
        }

        if (tranche == TRANCHE_Q) {
            return allowanceQ;
        } else if (tranche == TRANCHE_B) {
            return allowanceB;
        } else {
            return allowanceR;
        }
    }

    function trancheAllowanceVersion(address owner, address spender)
        external
        view
        override
        returns (uint256)
    {
        return _allowanceVersions[owner][spender];
    }

    function trancheTransfer(
        uint256 tranche,
        address recipient,
        uint256 amount,
        uint256 version
    ) external override onlyCurrentVersion(version) {
        _refreshBalance(msg.sender, version);
        _refreshBalance(recipient, version);
        _transfer(tranche, msg.sender, recipient, amount);
    }

    function trancheTransferFrom(
        uint256 tranche,
        address sender,
        address recipient,
        uint256 amount,
        uint256 version
    ) external override onlyCurrentVersion(version) {
        _refreshAllowance(sender, msg.sender, version);
        uint256 newAllowance =
            _allowances[sender][msg.sender][tranche].sub(
                amount,
                "ERC20: transfer amount exceeds allowance"
            );
        _approve(tranche, sender, msg.sender, newAllowance);
        _refreshBalance(sender, version);
        _refreshBalance(recipient, version);
        _transfer(tranche, sender, recipient, amount);
    }

    function trancheApprove(
        uint256 tranche,
        address spender,
        uint256 amount,
        uint256 version
    ) external override onlyCurrentVersion(version) {
        _refreshAllowance(msg.sender, spender, version);
        _approve(tranche, msg.sender, spender, amount);
    }

    function trancheTotalSupply(uint256 tranche) external view override returns (uint256) {
        return _totalSupplies[tranche];
    }

    function primaryMarketMint(
        uint256 tranche,
        address account,
        uint256 amount,
        uint256 version
    ) external override onlyPrimaryMarket onlyCurrentVersion(version) {
        _refreshBalance(account, version);
        _mint(tranche, account, amount);
    }

    function primaryMarketBurn(
        uint256 tranche,
        address account,
        uint256 amount,
        uint256 version
    ) external override onlyPrimaryMarket onlyCurrentVersion(version) {
        _refreshBalance(account, version);
        _burn(tranche, account, amount);
    }

    function shareTransfer(
        address sender,
        address recipient,
        uint256 amount
    ) public override {
        uint256 tranche = _getTranche(msg.sender);
        if (tranche != TRANCHE_Q) {
            require(isFundActive(block.timestamp), "Transfer is inactive");
        }
        _refreshBalance(sender, _rebalanceSize);
        _refreshBalance(recipient, _rebalanceSize);
        _transfer(tranche, sender, recipient, amount);
    }

    function shareTransferFrom(
        address spender,
        address sender,
        address recipient,
        uint256 amount
    ) external override returns (uint256 newAllowance) {
        uint256 tranche = _getTranche(msg.sender);
        shareTransfer(sender, recipient, amount);
        _refreshAllowance(sender, spender, _rebalanceSize);
        newAllowance = _allowances[sender][spender][tranche].sub(
            amount,
            "ERC20: transfer amount exceeds allowance"
        );
        _approve(tranche, sender, spender, newAllowance);
    }

    function shareApprove(
        address owner,
        address spender,
        uint256 amount
    ) external override {
        uint256 tranche = _getTranche(msg.sender);
        _refreshAllowance(owner, spender, _rebalanceSize);
        _approve(tranche, owner, spender, amount);
    }

    function shareIncreaseAllowance(
        address sender,
        address spender,
        uint256 addedValue
    ) external override returns (uint256 newAllowance) {
        uint256 tranche = _getTranche(msg.sender);
        _refreshAllowance(sender, spender, _rebalanceSize);
        newAllowance = _allowances[sender][spender][tranche].add(addedValue);
        _approve(tranche, sender, spender, newAllowance);
    }

    function shareDecreaseAllowance(
        address sender,
        address spender,
        uint256 subtractedValue
    ) external override returns (uint256 newAllowance) {
        uint256 tranche = _getTranche(msg.sender);
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
        IShareV2(_getShare(tranche)).fundEmitTransfer(sender, recipient, amount);
    }

    function _mint(
        uint256 tranche,
        address account,
        uint256 amount
    ) private {
        require(account != address(0), "ERC20: mint to the zero address");
        _totalSupplies[tranche] = _totalSupplies[tranche].add(amount);
        _balances[account][tranche] = _balances[account][tranche].add(amount);
        IShareV2(_getShare(tranche)).fundEmitTransfer(address(0), account, amount);
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
        IShareV2(_getShare(tranche)).fundEmitTransfer(account, address(0), amount);
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
        IShareV2(_getShare(tranche)).fundEmitApproval(owner, spender, amount);
    }

    /// @notice Settle the current trading day. Settlement includes the following changes
    ///         to the fund.
    ///
    ///         1. Charge protocol fee of the day.
    ///         2. Settle all pending creations and redemptions from the primary market.
    ///         3. Calculate NAV of the day and trigger rebalance if necessary.
    ///         4. Capture new interest rate for BISHOP.
    function settle() external nonReentrant {
        uint256 day = currentDay;
        require(day != 0, "Not initialized");
        require(block.timestamp >= day, "The current trading day does not end yet");
        uint256 price = twapOracle.getTwap(day);
        require(price != 0, "Underlying price for settlement is not ready yet");

        _collectFee();

        IPrimaryMarketV3(_primaryMarket).settle(day);

        _payFeeDebt();

        // Calculate NAV
        uint256 equivalentTotalB = getEquivalentTotalB();
        uint256 underlying = getTotalUnderlying();
        (uint256 navSum, uint256 navB, uint256 navR) =
            _extrapolateNav(day, day - 1 days, price, equivalentTotalB, underlying);

        if (_shouldTriggerRebalance(navB, navR)) {
            uint256 newSplitRatio = splitRatio.multiplyDecimal(navSum) / 2;
            _triggerRebalance(day, navSum, navB, navR, newSplitRatio);
            navB = UNIT;
            navR = UNIT;
            equivalentTotalB = getEquivalentTotalB();
            fundActivityStartTime = day + activityDelayTimeAfterRebalance;
        } else {
            fundActivityStartTime = day;
        }

        uint256 interestRate = _updateInterestRate(day);
        historicalInterestRate[day] = interestRate;

        historicalEquivalentTotalB[day] = equivalentTotalB;
        historicalUnderlying[day] = underlying;
        _historicalNavB[day] = navB;
        _historicalNavR[day] = navR;
        currentDay = day + 1 days;

        emit Settled(day, navB, navR, interestRate);
    }

    function transferToStrategy(uint256 amount) external override onlyStrategy {
        _strategyUnderlying = _strategyUnderlying.add(amount);
        IERC20(tokenUnderlying).safeTransfer(_strategy, amount);
    }

    function transferFromStrategy(uint256 amount) external override onlyStrategy {
        _strategyUnderlying = _strategyUnderlying.sub(amount);
        IERC20(tokenUnderlying).safeTransferFrom(_strategy, address(this), amount);
        _payFeeDebt();
    }

    function primaryMarketTransferUnderlying(
        address recipient,
        uint256 amount,
        uint256 fee
    ) external override onlyPrimaryMarket {
        IERC20(tokenUnderlying).safeTransfer(recipient, amount);
        feeDebt = feeDebt.add(fee);
        _totalDebt = _totalDebt.add(fee);
    }

    function primaryMarketAddDebt(uint256 amount, uint256 fee) external override onlyPrimaryMarket {
        redemptionDebt = redemptionDebt.add(amount);
        feeDebt = feeDebt.add(fee);
        _totalDebt = _totalDebt.add(amount).add(fee);
    }

    function primaryMarketPayDebt(uint256 amount) external override onlyPrimaryMarket {
        redemptionDebt = redemptionDebt.sub(amount);
        _totalDebt = _totalDebt.sub(amount);
        IERC20(tokenUnderlying).safeTransfer(msg.sender, amount);
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

    function proposePrimaryMarketUpdate(address newPrimaryMarket) external onlyOwner {
        _proposePrimaryMarketUpdate(newPrimaryMarket);
    }

    function applyPrimaryMarketUpdate(address newPrimaryMarket) external onlyOwner {
        require(
            IPrimaryMarketV3(_primaryMarket).canBeRemovedFromFund(),
            "Cannot update primary market"
        );
        _applyPrimaryMarketUpdate(newPrimaryMarket);
    }

    function proposeStrategyUpdate(address newStrategy) external onlyOwner {
        _proposeStrategyUpdate(newStrategy);
    }

    function applyStrategyUpdate(address newStrategy) external onlyOwner {
        require(_totalDebt == 0, "Cannot update strategy with debt");
        _applyStrategyUpdate(newStrategy);
    }

    function _updateDailyProtocolFeeRate(uint256 newDailyProtocolFeeRate) private {
        require(
            newDailyProtocolFeeRate <= MAX_DAILY_PROTOCOL_FEE_RATE,
            "Exceed max protocol fee rate"
        );
        dailyProtocolFeeRate = newDailyProtocolFeeRate;
        emit DailyProtocolFeeRateUpdated(newDailyProtocolFeeRate);
    }

    function updateDailyProtocolFeeRate(uint256 newDailyProtocolFeeRate) external onlyOwner {
        _updateDailyProtocolFeeRate(newDailyProtocolFeeRate);
    }

    function _updateTwapOracle(address newTwapOracle) private {
        twapOracle = ITwapOracleV2(newTwapOracle);
        emit TwapOracleUpdated(newTwapOracle);
    }

    function updateTwapOracle(address newTwapOracle) external onlyOwner {
        _updateTwapOracle(newTwapOracle);
    }

    function _updateAprOracle(address newAprOracle) private {
        aprOracle = IAprOracle(newAprOracle);
        emit AprOracleUpdated(newAprOracle);
    }

    function updateAprOracle(address newAprOracle) external onlyOwner {
        _updateAprOracle(newAprOracle);
    }

    function _updateBallot(address newBallot) private {
        ballot = IBallot(newBallot);
        emit BallotUpdated(newBallot);
    }

    function updateBallot(address newBallot) external onlyOwner {
        _updateBallot(newBallot);
    }

    function _updateFeeCollector(address newFeeCollector) private {
        feeCollector = newFeeCollector;
        emit FeeCollectorUpdated(newFeeCollector);
    }

    function updateFeeCollector(address newFeeCollector) external onlyOwner {
        _updateFeeCollector(newFeeCollector);
    }

    function _updateActivityDelayTime(uint256 delayTime) private {
        require(
            delayTime >= 30 minutes && delayTime <= 12 hours,
            "Exceed allowed delay time range"
        );
        activityDelayTimeAfterRebalance = delayTime;
        emit ActivityDelayTimeUpdated(delayTime);
    }

    function updateActivityDelayTime(uint256 delayTime) external onlyOwner {
        _updateActivityDelayTime(delayTime);
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

    function _payFeeDebt() private {
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
            _totalDebt = total - amount;
            // Call `feeCollector.checkpoint()` without errors.
            // This is a intended behavior because `feeCollector` may not have `checkpoint()`.
            (bool success, ) = feeCollector.call(abi.encodeWithSignature("checkpoint()"));
            if (!success) {
                // ignore
            }
            IERC20(tokenUnderlying).safeTransfer(feeCollector, amount);
            emit FeeDebtPaid(amount);
        }
    }

    /// @dev Check whether a new rebalance should be triggered. Rebalance is triggered if
    ///      ROOK's NAV over BISHOP's NAV is greater than the upper threshold or
    ///      less than the lower threshold.
    /// @param navB BISHOP's NAV before the rebalance
    /// @param navROrZero ROOK's NAV before the rebalance or zero if the NAV is negative
    /// @return Whether a new rebalance should be triggered
    function _shouldTriggerRebalance(uint256 navB, uint256 navROrZero) private view returns (bool) {
        uint256 rOverB = navROrZero.divideDecimal(navB);
        return rOverB < lowerRebalanceThreshold || rOverB > upperRebalanceThreshold;
    }

    /// @dev Create a new rebalance that resets NAV of all tranches to 1. Total supplies are
    ///      rebalanced immediately.
    /// @param day Trading day that triggers this rebalance
    /// @param navSum Sum of BISHOP and ROOK's NAV
    /// @param navB BISHOP's NAV before this rebalance
    /// @param navROrZero ROOK's NAV before this rebalance or zero if the NAV is negative
    /// @param newSplitRatio The new split ratio after this rebalance
    function _triggerRebalance(
        uint256 day,
        uint256 navSum,
        uint256 navB,
        uint256 navROrZero,
        uint256 newSplitRatio
    ) private {
        Rebalance memory rebalance = _calculateRebalance(navSum, navB, navROrZero, newSplitRatio);
        uint256 oldSize = _rebalanceSize;
        splitRatio = newSplitRatio;
        _historicalSplitRatio[oldSize + 1] = newSplitRatio;
        emit SplitRatioUpdated(newSplitRatio);
        _rebalances[oldSize] = rebalance;
        _rebalanceSize = oldSize + 1;
        emit RebalanceTriggered(
            oldSize,
            day,
            navSum,
            navB,
            navROrZero,
            rebalance.ratioB2Q,
            rebalance.ratioR2Q,
            rebalance.ratioBR
        );

        (
            _totalSupplies[TRANCHE_Q],
            _totalSupplies[TRANCHE_B],
            _totalSupplies[TRANCHE_R]
        ) = doRebalance(
            _totalSupplies[TRANCHE_Q],
            _totalSupplies[TRANCHE_B],
            _totalSupplies[TRANCHE_R],
            oldSize
        );
        _refreshBalance(address(this), oldSize + 1);
    }

    /// @dev Create a new rebalance matrix that resets given NAVs to (1, 1).
    ///
    ///      Note that ROOK's NAV can be negative before the rebalance when the underlying price
    ///      drops dramatically in a single trading day, in which case zero should be passed to
    ///      this function instead of the negative NAV.
    /// @param navSum Sum of BISHOP and ROOK's NAV
    /// @param navB BISHOP's NAV before the rebalance
    /// @param navROrZero ROOK's NAV before the rebalance or zero if the NAV is negative
    /// @param newSplitRatio The new split ratio after this rebalance
    /// @return The rebalance matrix
    function _calculateRebalance(
        uint256 navSum,
        uint256 navB,
        uint256 navROrZero,
        uint256 newSplitRatio
    ) private view returns (Rebalance memory) {
        uint256 ratioBR;
        uint256 ratioB2Q;
        uint256 ratioR2Q;
        if (navROrZero <= navB) {
            // Lower rebalance
            ratioBR = navROrZero;
            ratioB2Q = (navSum / 2 - navROrZero).divideDecimal(newSplitRatio);
            ratioR2Q = 0;
        } else {
            // Upper rebalance
            ratioBR = UNIT;
            ratioB2Q = (navB - UNIT).divideDecimal(newSplitRatio) / 2;
            ratioR2Q = (navROrZero - UNIT).divideDecimal(newSplitRatio) / 2;
        }
        return
            Rebalance({
                ratioB2Q: ratioB2Q,
                ratioR2Q: ratioR2Q,
                ratioBR: ratioBR,
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
        uint256 balanceQ = balanceTuple[TRANCHE_Q];
        uint256 balanceB = balanceTuple[TRANCHE_B];
        uint256 balanceR = balanceTuple[TRANCHE_R];
        _balanceVersions[account] = targetVersion;

        if (balanceQ == 0 && balanceB == 0 && balanceR == 0) {
            // Fast path for an empty account
            return;
        }

        for (uint256 i = oldVersion; i < targetVersion; i++) {
            (balanceQ, balanceB, balanceR) = doRebalance(balanceQ, balanceB, balanceR, i);
        }
        balanceTuple[TRANCHE_Q] = balanceQ;
        balanceTuple[TRANCHE_B] = balanceB;
        balanceTuple[TRANCHE_R] = balanceR;

        emit BalancesRebalanced(account, targetVersion, balanceQ, balanceB, balanceR);
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
        uint256 allowanceQ = allowanceTuple[TRANCHE_Q];
        uint256 allowanceB = allowanceTuple[TRANCHE_B];
        uint256 allowanceR = allowanceTuple[TRANCHE_R];
        _allowanceVersions[owner][spender] = targetVersion;

        if (allowanceQ == 0 && allowanceB == 0 && allowanceR == 0) {
            // Fast path for an empty allowance
            return;
        }

        for (uint256 i = oldVersion; i < targetVersion; i++) {
            (allowanceQ, allowanceB, allowanceR) = _rebalanceAllowance(
                allowanceQ,
                allowanceB,
                allowanceR,
                i
            );
        }
        allowanceTuple[TRANCHE_Q] = allowanceQ;
        allowanceTuple[TRANCHE_B] = allowanceB;
        allowanceTuple[TRANCHE_R] = allowanceR;

        emit AllowancesRebalanced(
            owner,
            spender,
            targetVersion,
            allowanceQ,
            allowanceB,
            allowanceR
        );
    }

    function _rebalanceAllowance(
        uint256 allowanceQ,
        uint256 allowanceB,
        uint256 allowanceR,
        uint256 index
    )
        private
        view
        returns (
            uint256 newAllowanceQ,
            uint256 newAllowanceB,
            uint256 newAllowanceR
        )
    {
        Rebalance storage rebalance = _rebalances[index];

        /// @dev using saturating arithmetic to avoid unconscious overflow revert
        newAllowanceQ = allowanceQ;
        newAllowanceB = allowanceB.saturatingMultiplyDecimal(rebalance.ratioBR);
        newAllowanceR = allowanceR.saturatingMultiplyDecimal(rebalance.ratioBR);
    }

    modifier onlyCurrentVersion(uint256 version) {
        require(_rebalanceSize == version, "Only current version");
        _;
    }
}
