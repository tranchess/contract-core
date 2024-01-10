// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../interfaces/IStableSwap.sol";
import "../interfaces/ILiquidityGauge.sol";
import "../interfaces/ITranchessSwapCallee.sol";
import "../interfaces/IWrappedERC20.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/AdvancedMath.sol";
import "../utils/ManagedPausable.sol";

abstract contract StableSwapV3 is IStableSwap, Ownable, ReentrancyGuard, ManagedPausable {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event LiquidityAdded(
        address indexed sender,
        address indexed recipient,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 lpOut,
        uint256 fee,
        uint256 adminFee,
        uint256 oraclePrice
    );
    event LiquidityRemoved(
        address indexed account,
        uint256 lpIn,
        uint256 baseOut,
        uint256 quotOut,
        uint256 fee,
        uint256 adminFee,
        uint256 oraclePrice
    );
    event Swap(
        address indexed sender,
        address indexed recipient,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 baseOut,
        uint256 quoteOut,
        uint256 fee,
        uint256 adminFee,
        uint256 oraclePrice
    );
    event Sync(uint256 base, uint256 quote, uint256 oraclePrice);
    event AmplRampUpdated(uint256 start, uint256 end, uint256 startTimestamp, uint256 endTimestamp);
    event FeeCollectorUpdated(address newFeeCollector);
    event FeeRateUpdated(uint256 newFeeRate);
    event AdminFeeRateUpdated(uint256 newAdminFeeRate);

    /// @param base Amount of base tokens after rebalance
    /// @param quote Amount of quote tokens after rebalance
    /// @param rebalanceTimestamp Rebalance timestamp if the stored base and quote amount are rebalanced, or zero otherwise
    struct RebalanceResult {
        uint256 base;
        uint256 quote;
        uint256 rebalanceTimestamp;
    }

    uint256 private constant AMPL_MAX_VALUE = 1e6;
    uint256 private constant AMPL_RAMP_MIN_TIME = 86400;
    uint256 private constant AMPL_RAMP_MAX_CHANGE = 10;
    uint256 private constant MAX_FEE_RATE = 0.9e18;
    uint256 private constant MAX_ADMIN_FEE_RATE = 1e18;
    uint256 private constant MAX_ITERATION = 255;
    uint256 private constant MINIMUM_LIQUIDITY = 1e3;

    address public immutable lpToken;
    IFundV3 public immutable override fund;
    uint256 public immutable override baseTranche;
    address public immutable override quoteAddress;

    /// @dev A multipler that normalizes a quote asset balance to 18 decimal places.
    uint256 internal immutable _quoteDecimalMultiplier;

    uint256 public baseBalance;
    uint256 public quoteBalance;

    uint256 private _priceOverOracleIntegral;
    uint256 private _priceOverOracleTimestamp;

    uint256 public amplRampStart;
    uint256 public amplRampEnd;
    uint256 public amplRampStartTimestamp;
    uint256 public amplRampEndTimestamp;

    address public feeCollector;
    uint256 public normalFeeRate;
    uint256 public adminFeeRate;
    uint256 public totalAdminFee;

    constructor(
        address lpToken_,
        address fund_,
        uint256 baseTranche_,
        address quoteAddress_,
        uint256 quoteDecimals_,
        uint256 ampl_,
        address feeCollector_,
        uint256 feeRate_,
        uint256 adminFeeRate_
    ) public {
        lpToken = lpToken_;
        fund = IFundV3(fund_);
        baseTranche = baseTranche_;
        quoteAddress = quoteAddress_;
        require(quoteDecimals_ <= 18, "Quote asset decimals larger than 18");
        _quoteDecimalMultiplier = 10 ** (18 - quoteDecimals_);

        require(ampl_ > 0 && ampl_ < AMPL_MAX_VALUE, "Invalid A");
        amplRampEnd = ampl_;
        emit AmplRampUpdated(ampl_, ampl_, 0, 0);

        _updateFeeCollector(feeCollector_);
        _updateFeeRate(feeRate_);
        _updateAdminFeeRate(adminFeeRate_);

        _initializeManagedPausable(msg.sender);
    }

    receive() external payable {}

    function baseAddress() external view override returns (address) {
        return fund.tokenShare(baseTranche);
    }

    function allBalances() external view override returns (uint256, uint256) {
        (RebalanceResult memory result, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        return (result.base, result.quote);
    }

    function getAmpl() public view returns (uint256) {
        uint256 endTimestamp = amplRampEndTimestamp;
        if (block.timestamp < endTimestamp) {
            uint256 startTimestamp = amplRampStartTimestamp;
            uint256 start = amplRampStart;
            uint256 end = amplRampEnd;
            if (end > start) {
                return
                    start +
                    ((end - start) * (block.timestamp - startTimestamp)) /
                    (endTimestamp - startTimestamp);
            } else {
                return
                    start -
                    ((start - end) * (block.timestamp - startTimestamp)) /
                    (endTimestamp - startTimestamp);
            }
        } else {
            return amplRampEnd;
        }
    }

    function feeRate() external view returns (uint256) {
        uint256 version = fund.getRebalanceSize();
        uint256 rebalanceTimestamp = version == 0 ? 0 : fund.getRebalanceTimestamp(version - 1);
        return _getFeeRate(rebalanceTimestamp);
    }

    function _getFeeRate(uint256 rebalanceTimestamp) private view returns (uint256) {
        if (rebalanceTimestamp <= block.timestamp - 1 days) {
            return normalFeeRate;
        }
        uint256 coolingOff = rebalanceTimestamp > block.timestamp
            ? 1 days
            : rebalanceTimestamp - (block.timestamp - 1 days);
        uint256 coolingFeeRate = (MAX_FEE_RATE * coolingOff) / 1 days;
        return normalFeeRate < coolingFeeRate ? coolingFeeRate : normalFeeRate;
    }

    function getCurrentD() external view override returns (uint256) {
        (RebalanceResult memory result, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        return _getD(result.base, result.quote, getAmpl(), getOraclePrice());
    }

    function getCurrentPriceOverOracle() public view override returns (uint256) {
        (RebalanceResult memory result, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        if (result.base == 0 || result.quote == 0) {
            return 1e18;
        }
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d = _getD(result.base, result.quote, ampl, oraclePrice);
        return _getPriceOverOracle(result.base, result.quote, ampl, oraclePrice, d);
    }

    /// @notice Get the current swap price, i.e. negative slope at the current point on the curve.
    ///         The returned value is computed after both base and quote balances are normalized to
    ///         18 decimal places. If the quote token does not have 18 decimal places, the returned
    ///         value has a different order of magnitude than the ratio of quote amount to base
    ///         amount in a swap.
    function getCurrentPrice() external view override returns (uint256) {
        (RebalanceResult memory result, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        uint256 oraclePrice = getOraclePrice();
        if (result.base == 0 || result.quote == 0) {
            return oraclePrice;
        }
        uint256 ampl = getAmpl();
        uint256 d = _getD(result.base, result.quote, ampl, oraclePrice);
        return
            _getPriceOverOracle(result.base, result.quote, ampl, oraclePrice, d).multiplyDecimal(
                oraclePrice
            );
    }

    function getPriceOverOracleIntegral() external view override returns (uint256) {
        return
            _priceOverOracleIntegral +
            getCurrentPriceOverOracle() *
            (block.timestamp - _priceOverOracleTimestamp);
    }

    function getQuoteOut(uint256 baseIn) external view override returns (uint256 quoteOut) {
        (RebalanceResult memory old, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        uint256 newBase = old.base.add(baseIn);
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        // Add 1 in case of rounding errors
        uint256 d = _getD(old.base, old.quote, ampl, oraclePrice) + 1;
        uint256 newQuote = _getQuote(ampl, newBase, oraclePrice, d) + 1;
        quoteOut = old.quote.sub(newQuote);
        // Round down output after fee
        quoteOut = quoteOut.multiplyDecimal(1e18 - _getFeeRate(old.rebalanceTimestamp));
    }

    function getQuoteIn(uint256 baseOut) external view override returns (uint256 quoteIn) {
        (RebalanceResult memory old, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        uint256 newBase = old.base.sub(baseOut);
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        // Add 1 in case of rounding errors
        uint256 d = _getD(old.base, old.quote, ampl, oraclePrice) + 1;
        uint256 newQuote = _getQuote(ampl, newBase, oraclePrice, d) + 1;
        quoteIn = newQuote.sub(old.quote);
        uint256 feeRate_ = _getFeeRate(old.rebalanceTimestamp);
        // Round up input before fee
        quoteIn = quoteIn.mul(1e18).add(1e18 - feeRate_ - 1) / (1e18 - feeRate_);
    }

    function getBaseOut(uint256 quoteIn) external view override returns (uint256 baseOut) {
        (RebalanceResult memory old, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        // Round down input after fee
        uint256 quoteInAfterFee = quoteIn.multiplyDecimal(
            1e18 - _getFeeRate(old.rebalanceTimestamp)
        );
        uint256 newQuote = old.quote.add(quoteInAfterFee);
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        // Add 1 in case of rounding errors
        uint256 d = _getD(old.base, old.quote, ampl, oraclePrice) + 1;
        uint256 newBase = _getBase(ampl, newQuote, oraclePrice, d) + 1;
        baseOut = old.base.sub(newBase);
    }

    function getBaseIn(uint256 quoteOut) external view override returns (uint256 baseIn) {
        (RebalanceResult memory old, , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        uint256 feeRate_ = _getFeeRate(old.rebalanceTimestamp);
        // Round up output before fee
        uint256 quoteOutBeforeFee = quoteOut.mul(1e18).add(1e18 - feeRate_ - 1) / (1e18 - feeRate_);
        uint256 newQuote = old.quote.sub(quoteOutBeforeFee);
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        // Add 1 in case of rounding errors
        uint256 d = _getD(old.base, old.quote, ampl, oraclePrice) + 1;
        uint256 newBase = _getBase(ampl, newQuote, oraclePrice, d) + 1;
        baseIn = newBase.sub(old.base);
    }

    function buy(
        uint256 version,
        uint256 baseOut,
        address recipient,
        bytes calldata data
    )
        external
        override
        nonReentrant
        checkVersion(version)
        whenNotPaused
        returns (uint256 realBaseOut)
    {
        require(baseOut > 0, "Zero output");
        realBaseOut = baseOut;
        RebalanceResult memory old = _handleRebalance(version);
        require(baseOut < old.base, "Insufficient liquidity");
        // Optimistically transfer tokens.
        fund.trancheTransfer(baseTranche, recipient, baseOut, version);
        if (data.length > 0) {
            ITranchessSwapCallee(msg.sender).tranchessSwapCallback(baseOut, 0, data);
            _checkVersion(version); // Make sure no rebalance is triggered in the callback
        }
        uint256 newQuote = _getNewQuoteBalance();
        uint256 quoteIn = newQuote.sub(old.quote);
        uint256 fee = quoteIn.multiplyDecimal(_getFeeRate(old.rebalanceTimestamp));
        uint256 oraclePrice = getOraclePrice();
        {
            uint256 ampl = getAmpl();
            uint256 oldD = _getD(old.base, old.quote, ampl, oraclePrice);
            _updatePriceOverOracleIntegral(old.base, old.quote, ampl, oraclePrice, oldD);
            uint256 newD = _getD(old.base - baseOut, newQuote.sub(fee), ampl, oraclePrice);
            require(newD >= oldD, "Invariant mismatch");
        }
        uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
        baseBalance = old.base - baseOut;
        quoteBalance = newQuote.sub(adminFee);
        totalAdminFee = totalAdminFee.add(adminFee);
        uint256 baseOut_ = baseOut;
        emit Swap(msg.sender, recipient, 0, quoteIn, baseOut_, 0, fee, adminFee, oraclePrice);
    }

    function sell(
        uint256 version,
        uint256 quoteOut,
        address recipient,
        bytes calldata data
    )
        external
        override
        nonReentrant
        checkVersion(version)
        whenNotPaused
        returns (uint256 realQuoteOut)
    {
        require(quoteOut > 0, "Zero output");
        realQuoteOut = quoteOut;
        RebalanceResult memory old = _handleRebalance(version);
        // Optimistically transfer tokens.
        IERC20(quoteAddress).safeTransfer(recipient, quoteOut);
        if (data.length > 0) {
            ITranchessSwapCallee(msg.sender).tranchessSwapCallback(0, quoteOut, data);
            _checkVersion(version); // Make sure no rebalance is triggered in the callback
        }
        uint256 newBase = fund.trancheBalanceOf(baseTranche, address(this));
        uint256 baseIn = newBase.sub(old.base);
        uint256 fee;
        {
            uint256 feeRate_ = _getFeeRate(old.rebalanceTimestamp);
            fee = quoteOut.mul(feeRate_).div(1e18 - feeRate_);
        }
        require(quoteOut.add(fee) < old.quote, "Insufficient liquidity");
        uint256 oraclePrice = getOraclePrice();
        {
            uint256 newQuote = old.quote - quoteOut;
            uint256 ampl = getAmpl();
            uint256 oldD = _getD(old.base, old.quote, ampl, oraclePrice);
            _updatePriceOverOracleIntegral(old.base, old.quote, ampl, oraclePrice, oldD);
            uint256 newD = _getD(newBase, newQuote - fee, ampl, oraclePrice);
            require(newD >= oldD, "Invariant mismatch");
        }
        uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
        baseBalance = newBase;
        quoteBalance = old.quote - quoteOut - adminFee;
        totalAdminFee = totalAdminFee.add(adminFee);
        uint256 quoteOut_ = quoteOut;
        emit Swap(msg.sender, recipient, baseIn, 0, 0, quoteOut_, fee, adminFee, oraclePrice);
    }

    /// @notice Add liquidity. This function should be called by a smart contract, which transfers
    ///         base and quote tokens to this contract in the same transaction.
    /// @param version The latest rebalance version
    /// @param recipient Recipient of minted LP tokens
    /// @param lpOut Amount of minted LP tokens
    function addLiquidity(
        uint256 version,
        address recipient
    ) external override nonReentrant checkVersion(version) whenNotPaused returns (uint256 lpOut) {
        RebalanceResult memory old = _handleRebalance(version);
        uint256 newBase = fund.trancheBalanceOf(baseTranche, address(this));
        uint256 newQuote = _getNewQuoteBalance();
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        if (lpSupply == 0) {
            require(newBase > 0 && newQuote > 0, "Zero initial balance");
            baseBalance = newBase;
            quoteBalance = newQuote;
            // Overflow is desired
            _priceOverOracleIntegral += 1e18 * (block.timestamp - _priceOverOracleTimestamp);
            _priceOverOracleTimestamp = block.timestamp;
            uint256 d1 = _getD(newBase, newQuote, ampl, oraclePrice);
            ILiquidityGauge(lpToken).mint(address(this), MINIMUM_LIQUIDITY);
            ILiquidityGauge(lpToken).mint(recipient, d1.sub(MINIMUM_LIQUIDITY));
            emit LiquidityAdded(msg.sender, recipient, newBase, newQuote, d1, 0, 0, oraclePrice);
            return d1;
        }
        uint256 fee;
        uint256 adminFee;
        {
            // Initial invariant
            uint256 d0 = _getD(old.base, old.quote, ampl, oraclePrice);
            _updatePriceOverOracleIntegral(old.base, old.quote, ampl, oraclePrice, d0);
            {
                // New invariant before charging fee
                uint256 d1 = _getD(newBase, newQuote, ampl, oraclePrice);
                uint256 idealQuote = d1.mul(old.quote) / d0;
                uint256 difference = idealQuote > newQuote
                    ? idealQuote - newQuote
                    : newQuote - idealQuote;
                fee = difference.multiplyDecimal(_getFeeRate(old.rebalanceTimestamp));
            }
            adminFee = fee.multiplyDecimal(adminFeeRate);
            totalAdminFee = totalAdminFee.add(adminFee);
            baseBalance = newBase;
            quoteBalance = newQuote.sub(adminFee);
            // New invariant after charging fee
            uint256 d2 = _getD(newBase, newQuote.sub(fee), ampl, oraclePrice);
            require(d2 > d0, "No liquidity is added");
            lpOut = lpSupply.mul(d2.sub(d0)).div(d0);
        }
        ILiquidityGauge(lpToken).mint(recipient, lpOut);
        emit LiquidityAdded(
            msg.sender,
            recipient,
            newBase - old.base,
            newQuote - old.quote,
            lpOut,
            fee,
            adminFee,
            oraclePrice
        );
    }

    /// @dev Remove liquidity proportionally.
    /// @param lpIn Exact amount of LP token to burn
    /// @param minBaseOut Least amount of base asset to withdraw
    /// @param minQuoteOut Least amount of quote asset to withdraw
    function removeLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minBaseOut,
        uint256 minQuoteOut
    )
        external
        override
        nonReentrant
        checkVersion(version)
        returns (uint256 baseOut, uint256 quoteOut)
    {
        (baseOut, quoteOut) = _removeLiquidity(version, lpIn, minBaseOut, minQuoteOut);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteOut);
    }

    /// @dev Remove liquidity proportionally and unwrap for native token.
    /// @param lpIn Exact amount of LP token to burn
    /// @param minBaseOut Least amount of base asset to withdraw
    /// @param minQuoteOut Least amount of quote asset to withdraw
    function removeLiquidityUnwrap(
        uint256 version,
        uint256 lpIn,
        uint256 minBaseOut,
        uint256 minQuoteOut
    )
        external
        override
        nonReentrant
        checkVersion(version)
        returns (uint256 baseOut, uint256 quoteOut)
    {
        (baseOut, quoteOut) = _removeLiquidity(version, lpIn, minBaseOut, minQuoteOut);
        IWrappedERC20(quoteAddress).withdraw(quoteOut);
        (bool success, ) = msg.sender.call{value: quoteOut}("");
        require(success, "Transfer failed");
    }

    function _removeLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minBaseOut,
        uint256 minQuoteOut
    ) internal returns (uint256 baseOut, uint256 quoteOut) {
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        RebalanceResult memory old = _handleRebalance(version);
        baseOut = old.base.mul(lpIn).div(lpSupply);
        quoteOut = old.quote.mul(lpIn).div(lpSupply);
        require(baseOut >= minBaseOut, "Insufficient output");
        require(quoteOut >= minQuoteOut, "Insufficient output");
        baseBalance = old.base.sub(baseOut);
        quoteBalance = old.quote.sub(quoteOut);
        ILiquidityGauge(lpToken).burnFrom(msg.sender, lpIn);
        fund.trancheTransfer(baseTranche, msg.sender, baseOut, version);
        emit LiquidityRemoved(msg.sender, lpIn, baseOut, quoteOut, 0, 0, 0);
    }

    /// @dev Remove base liquidity only.
    /// @param lpIn Exact amount of LP token to burn
    /// @param minBaseOut Least amount of base asset to withdraw
    function removeBaseLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minBaseOut
    ) external override nonReentrant checkVersion(version) whenNotPaused returns (uint256 baseOut) {
        RebalanceResult memory old = _handleRebalance(version);
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d1;
        {
            uint256 d0 = _getD(old.base, old.quote, ampl, oraclePrice);
            _updatePriceOverOracleIntegral(old.base, old.quote, ampl, oraclePrice, d0);
            d1 = d0.sub(d0.mul(lpIn).div(lpSupply));
        }
        {
            uint256 fee = old.quote.mul(lpIn).div(lpSupply).multiplyDecimal(
                _getFeeRate(old.rebalanceTimestamp)
            );
            // Add 1 in case of rounding errors
            uint256 newBase = _getBase(ampl, old.quote.sub(fee), oraclePrice, d1) + 1;
            baseOut = old.base.sub(newBase);
            require(baseOut >= minBaseOut, "Insufficient output");
            ILiquidityGauge(lpToken).burnFrom(msg.sender, lpIn);
            baseBalance = newBase;
            uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
            totalAdminFee = totalAdminFee.add(adminFee);
            quoteBalance = old.quote.sub(adminFee);
            emit LiquidityRemoved(msg.sender, lpIn, baseOut, 0, fee, adminFee, oraclePrice);
        }
        fund.trancheTransfer(baseTranche, msg.sender, baseOut, version);
    }

    /// @dev Remove quote liquidity only.
    /// @param lpIn Exact amount of LP token to burn
    /// @param minQuoteOut Least amount of quote asset to withdraw
    function removeQuoteLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minQuoteOut
    )
        external
        override
        nonReentrant
        checkVersion(version)
        whenNotPaused
        returns (uint256 quoteOut)
    {
        quoteOut = _removeQuoteLiquidity(version, lpIn, minQuoteOut);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteOut);
    }

    /// @dev Remove quote liquidity only and unwrap for native token.
    /// @param lpIn Exact amount of LP token to burn
    /// @param minQuoteOut Least amount of quote asset to withdraw
    function removeQuoteLiquidityUnwrap(
        uint256 version,
        uint256 lpIn,
        uint256 minQuoteOut
    )
        external
        override
        nonReentrant
        checkVersion(version)
        whenNotPaused
        returns (uint256 quoteOut)
    {
        quoteOut = _removeQuoteLiquidity(version, lpIn, minQuoteOut);
        IWrappedERC20(quoteAddress).withdraw(quoteOut);
        (bool success, ) = msg.sender.call{value: quoteOut}("");
        require(success, "Transfer failed");
    }

    function _removeQuoteLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minQuoteOut
    ) internal returns (uint256 quoteOut) {
        RebalanceResult memory old = _handleRebalance(version);
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d1;
        {
            uint256 d0 = _getD(old.base, old.quote, ampl, oraclePrice);
            _updatePriceOverOracleIntegral(old.base, old.quote, ampl, oraclePrice, d0);
            d1 = d0.sub(d0.mul(lpIn).div(lpSupply));
        }
        uint256 idealQuote = old.quote.mul(lpSupply.sub(lpIn)).div(lpSupply);
        // Add 1 in case of rounding errors
        uint256 newQuote = _getQuote(ampl, old.base, oraclePrice, d1) + 1;
        uint256 fee = idealQuote.sub(newQuote).multiplyDecimal(_getFeeRate(old.rebalanceTimestamp));
        quoteOut = old.quote.sub(newQuote).sub(fee);
        require(quoteOut >= minQuoteOut, "Insufficient output");
        ILiquidityGauge(lpToken).burnFrom(msg.sender, lpIn);
        uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
        totalAdminFee = totalAdminFee.add(adminFee);
        quoteBalance = newQuote.add(fee).sub(adminFee);
        emit LiquidityRemoved(msg.sender, lpIn, 0, quoteOut, fee, adminFee, oraclePrice);
    }

    /// @notice Force stored values to match balances.
    function sync() external nonReentrant {
        RebalanceResult memory old = _handleRebalance(fund.getRebalanceSize());
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d = _getD(old.base, old.quote, ampl, oraclePrice);
        _updatePriceOverOracleIntegral(old.base, old.quote, ampl, oraclePrice, d);
        uint256 newBase = fund.trancheBalanceOf(baseTranche, address(this));
        uint256 newQuote = _getNewQuoteBalance();
        baseBalance = newBase;
        quoteBalance = newQuote;
        emit Sync(newBase, newQuote, oraclePrice);
    }

    function collectFee() external {
        uint256 totalAdminFee_ = totalAdminFee;
        delete totalAdminFee;
        IERC20(quoteAddress).safeTransfer(feeCollector, totalAdminFee_);
    }

    function _getNewQuoteBalance() private view returns (uint256) {
        return IERC20(quoteAddress).balanceOf(address(this)).sub(totalAdminFee);
    }

    function _updatePriceOverOracleIntegral(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 oraclePrice,
        uint256 d
    ) private {
        // Overflow is desired
        _priceOverOracleIntegral +=
            _getPriceOverOracle(base, quote, ampl, oraclePrice, d) *
            (block.timestamp - _priceOverOracleTimestamp);
        _priceOverOracleTimestamp = block.timestamp;
    }

    function _getD(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 oraclePrice
    ) private view returns (uint256) {
        // Newtonian: D' = (4A(kx + y) + D^3 / 2kxy)D / ((4A - 1)D + 3D^3 / 4kxy)
        uint256 normalizedQuote = quote.mul(_quoteDecimalMultiplier);
        uint256 baseValue = base.multiplyDecimal(oraclePrice);
        uint256 sum = baseValue.add(normalizedQuote);
        if (sum == 0) return 0;

        uint256 prev = 0;
        uint256 d = sum;
        for (uint256 i = 0; i < MAX_ITERATION; i++) {
            prev = d;
            uint256 d3 = d.mul(d).div(baseValue).mul(d) / normalizedQuote / 4;
            d = (sum.mul(4 * ampl) + 2 * d3).mul(d) / d.mul(4 * ampl - 1).add(3 * d3);
            if (d <= prev + 1 && prev <= d + 1) {
                break;
            }
        }
        return d;
    }

    function _getPriceOverOracle(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 oraclePrice,
        uint256 d
    ) private view returns (uint256) {
        uint256 commonExp = d.multiplyDecimal(4e18 - 1e18 / ampl);
        uint256 baseValue = base.multiplyDecimal(oraclePrice);
        uint256 normalizedQuote = quote.mul(_quoteDecimalMultiplier);
        return
            (baseValue.mul(8).add(normalizedQuote.mul(4)).sub(commonExp))
                .multiplyDecimal(normalizedQuote)
                .divideDecimal(normalizedQuote.mul(8).add(baseValue.mul(4)).sub(commonExp))
                .divideDecimal(baseValue);
    }

    function _getBase(
        uint256 ampl,
        uint256 quote,
        uint256 oraclePrice,
        uint256 d
    ) private view returns (uint256 base) {
        // Solve 16Ayk^2·x^2 + 4ky(4Ay - 4AD + D)·x - D^3 = 0
        // Newtonian: kx' = ((kx)^2 + D^3 / 16Ay) / (2kx + y - D + D/4A)
        uint256 normalizedQuote = quote.mul(_quoteDecimalMultiplier);
        uint256 d3 = d.mul(d).div(normalizedQuote).mul(d) / (16 * ampl);
        uint256 prev = 0;
        uint256 baseValue = d;
        for (uint256 i = 0; i < MAX_ITERATION; i++) {
            prev = baseValue;
            baseValue =
                baseValue.mul(baseValue).add(d3) /
                (2 * baseValue).add(normalizedQuote).add(d / (4 * ampl)).sub(d);
            if (baseValue <= prev + 1 && prev <= baseValue + 1) {
                break;
            }
        }
        base = baseValue.divideDecimal(oraclePrice);
    }

    function _getQuote(
        uint256 ampl,
        uint256 base,
        uint256 oraclePrice,
        uint256 d
    ) private view returns (uint256 quote) {
        // Solve 16Axk·y^2 + 4kx(4Akx - 4AD + D)·y - D^3 = 0
        // Newtonian: y' = (y^2 + D^3 / 16Akx) / (2y + kx - D + D/4A)
        uint256 baseValue = base.multiplyDecimal(oraclePrice);
        uint256 d3 = d.mul(d).div(baseValue).mul(d) / (16 * ampl);
        uint256 prev = 0;
        uint256 normalizedQuote = d;
        for (uint256 i = 0; i < MAX_ITERATION; i++) {
            prev = normalizedQuote;
            normalizedQuote =
                normalizedQuote.mul(normalizedQuote).add(d3) /
                (2 * normalizedQuote).add(baseValue).add(d / (4 * ampl)).sub(d);
            if (normalizedQuote <= prev + 1 && prev <= normalizedQuote + 1) {
                break;
            }
        }
        quote = normalizedQuote / _quoteDecimalMultiplier;
    }

    function updateAmplRamp(uint256 endAmpl, uint256 endTimestamp) external onlyOwner {
        require(endAmpl > 0 && endAmpl < AMPL_MAX_VALUE, "Invalid A");
        require(endTimestamp >= block.timestamp + AMPL_RAMP_MIN_TIME, "A ramp time too short");
        uint256 ampl = getAmpl();
        require(
            (endAmpl >= ampl && endAmpl <= ampl * AMPL_RAMP_MAX_CHANGE) ||
                (endAmpl < ampl && endAmpl * AMPL_RAMP_MAX_CHANGE >= ampl),
            "A ramp change too large"
        );
        amplRampStart = ampl;
        amplRampEnd = endAmpl;
        amplRampStartTimestamp = block.timestamp;
        amplRampEndTimestamp = endTimestamp;
        emit AmplRampUpdated(ampl, endAmpl, block.timestamp, endTimestamp);
    }

    function _updateFeeCollector(address newFeeCollector) private {
        feeCollector = newFeeCollector;
        emit FeeCollectorUpdated(newFeeCollector);
    }

    function updateFeeCollector(address newFeeCollector) external onlyOwner {
        _updateFeeCollector(newFeeCollector);
    }

    function _updateFeeRate(uint256 newFeeRate) private {
        require(newFeeRate <= MAX_FEE_RATE, "Exceed max fee rate");
        normalFeeRate = newFeeRate;
        emit FeeRateUpdated(newFeeRate);
    }

    function updateFeeRate(uint256 newFeeRate) external onlyOwner {
        _updateFeeRate(newFeeRate);
    }

    function _updateAdminFeeRate(uint256 newAdminFeeRate) private {
        require(newAdminFeeRate <= MAX_ADMIN_FEE_RATE, "Exceed max admin fee rate");
        adminFeeRate = newAdminFeeRate;
        emit AdminFeeRateUpdated(newAdminFeeRate);
    }

    function updateAdminFeeRate(uint256 newAdminFeeRate) external onlyOwner {
        _updateAdminFeeRate(newAdminFeeRate);
    }

    /// @dev Check if the user-specified version is correct.
    modifier checkVersion(uint256 version) {
        _checkVersion(version);
        _;
    }

    /// @dev Revert if the user-specified version is not correct.
    function _checkVersion(uint256 version) internal view virtual {}

    /// @dev Compute the new base and quote amount after rebalanced to the latest version.
    ///      If any tokens should be distributed to LP holders, their amounts are also returned.
    ///
    ///      The latest rebalance version is passed in a parameter and it is caller's responsibility
    ///      to pass the correct version.
    /// @param latestVersion The latest rebalance version
    /// @return result Amount of stored base and quote tokens after rebalance
    /// @return excessiveQ Amount of QUEEN that should be distributed to LP holders due to rebalance
    /// @return excessiveB Amount of BISHOP that should be distributed to LP holders due to rebalance
    /// @return excessiveR Amount of ROOK that should be distributed to LP holders due to rebalance
    /// @return excessiveQuote Amount of quote tokens that should be distributed to LP holders due to rebalance
    function _getRebalanceResult(
        uint256 latestVersion
    )
        internal
        view
        virtual
        returns (
            RebalanceResult memory result,
            uint256 excessiveQ,
            uint256 excessiveB,
            uint256 excessiveR,
            uint256 excessiveQuote
        );

    /// @dev Update the stored base and quote balance to the latest rebalance version and distribute
    ///      any excessive tokens to LP holders.
    ///
    ///      The latest rebalance version is passed in a parameter and it is caller's responsibility
    ///      to pass the correct version.
    /// @param latestVersion The latest rebalance version
    /// @return result Amount of stored base and quote tokens after rebalance
    function _handleRebalance(
        uint256 latestVersion
    ) internal virtual returns (RebalanceResult memory result);

    /// @notice Get the base token price from the price oracle. The returned price is normalized
    ///         to 18 decimal places.
    function getOraclePrice() public view virtual override returns (uint256);
}
