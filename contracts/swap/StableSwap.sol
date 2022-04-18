// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../interfaces/IStableSwap.sol";
import "../interfaces/ILiquidityGauge.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/ITranchessSwapCallee.sol";

import "../utils/SafeDecimalMath.sol";
import "../utils/AdvancedMath.sol";

enum Operation {SWAP, ADD_LIQUIDITY, REMOVE_LIQUIDITY, VIEW}

abstract contract StableSwap is IStableSwap, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event Swap(
        address indexed sender,
        uint256 baseOut,
        uint256 quoteOut,
        uint256 baseIn,
        uint256 quoteIn,
        address indexed to
    );

    event Sync(uint256 baseBalance, uint256 quoteBalance);

    uint256 private constant MIN_DIFF = 2;
    uint256 private constant MAX_ITERATION = 255;

    address public immutable lpToken;
    IFundV3 public immutable fund;
    uint256 public immutable baseTranche;
    address public override quoteAddress;

    uint256 public baseBalance;
    uint256 public quoteBalance;

    uint256 public baseCumulativeLast;
    uint256 public quoteCumulativeLast;
    uint256 private blockTimestampLast;

    uint256 public initialAmpl;
    uint256 public futureAmpl;
    uint256 public initialTime;
    uint256 public futureTime;

    address public feeCollector;
    uint256 public feeRate;
    uint256 public adminFeeRate;
    uint256 public totalAdminFee;

    constructor(
        address lpToken_,
        address fund_,
        uint256 baseTranche_,
        address quoteAddress_,
        uint256 initialAmpl_,
        uint256 futureAmpl_,
        address feeCollector_,
        uint256 feeRate_,
        uint256 adminFeeRate_
    ) public {
        lpToken = lpToken_;
        fund = IFundV3(fund_);
        baseTranche = baseTranche_;
        quoteAddress = quoteAddress_;

        initialAmpl = initialAmpl_;
        futureAmpl = futureAmpl_;

        feeCollector = feeCollector_;
        feeRate = feeRate_;
        adminFeeRate = adminFeeRate_;
    }

    function baseAddress() public view override returns (address) {
        return fund.tokenShare(baseTranche);
    }

    function allBalances() public view override returns (uint256, uint256) {
        return (baseBalance, quoteBalance);
    }

    function getAmpl() public view returns (uint256) {
        if (block.timestamp < futureTime) {
            uint256 deltaAmpl =
                futureAmpl > initialAmpl
                    ? futureAmpl.sub(initialAmpl)
                    : initialAmpl.sub(futureAmpl);
            uint256 deltaTime = block.timestamp.sub(initialTime);
            uint256 timeInterval = futureTime.sub(initialTime);

            if (futureAmpl > initialAmpl) {
                return initialAmpl.add(deltaAmpl.mul(deltaTime).div(timeInterval));
            } else {
                return initialAmpl.sub(deltaAmpl.mul(deltaTime).div(timeInterval));
            }
        } else {
            return futureAmpl;
        }
    }

    function getCurrentD() public view override returns (uint256) {
        uint256 oracle = checkOracle(Operation.VIEW);
        (uint256 base, uint256 quote, , , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        return _getD(base, quote, getAmpl(), oracle);
    }

    function getD(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 oracle
    ) external view override returns (uint256) {
        return _getD(base, quote, ampl, oracle);
    }

    function getQuoteOut(uint256 baseIn) external view override returns (uint256 quoteOut) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 newBase = oldBase.add(baseIn);
        uint256 newQuote = _getQuoteBalance(newBase);
        quoteOut = oldQuote.sub(newQuote).sub(1); // -1 just in case there were some rounding errors
        uint256 fee = quoteOut.multiplyDecimal(feeRate);
        quoteOut = quoteOut.sub(fee);
    }

    function getQuoteIn(uint256 baseOut) external view override returns (uint256 quoteIn) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 newBase = oldBase.sub(baseOut);
        uint256 newQuote = _getQuoteBalance(newBase);
        quoteIn = newQuote.sub(oldQuote).add(1); // 1 just in case there were some rounding errors
        uint256 fee = quoteIn.mul(feeRate).div(uint256(1e18).sub(feeRate));
        quoteIn = quoteIn.add(fee);
    }

    function getBaseOut(uint256 quoteIn) external view override returns (uint256 baseOut) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 fee = quoteIn.multiplyDecimal(feeRate);
        uint256 newQuote = oldQuote.add(quoteIn.sub(fee));
        uint256 newBase = _getBaseBalance(newQuote);
        baseOut = oldBase.sub(newBase).sub(1); // just in case there were rounding error
    }

    function getBaseIn(uint256 quoteOut) external view override returns (uint256 baseIn) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 fee = quoteOut.mul(feeRate).div(uint256(1e18).sub(feeRate));
        uint256 newQuote = oldQuote.sub(quoteOut.add(fee));
        uint256 newBase = _getBaseBalance(newQuote);
        baseIn = newBase.sub(oldBase).add(1); // just in case there were rounding error
    }

    /// @dev Average asset value per LP token
    function virtualPrice() public view override returns (uint256) {
        uint256 d = getCurrentD();
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        return d.divideDecimal(lpSupply);
    }

    /// @dev Estimate the amount of LP to mint/burn with a specified supply/withdraw distribution
    function calculateTokenAmount(
        uint256 baseDelta,
        uint256 quoteDelta,
        bool deposit
    ) public view override returns (uint256) {
        uint256 ampl = getAmpl();
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 newBaseBalance;
        uint256 newQuoteBalance;
        (uint256 baseBalance_, uint256 quoteBalance_, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 oracle = checkOracle(Operation.VIEW);
        uint256 d0 = _getD(baseBalance_, quoteBalance_, ampl, oracle);

        newBaseBalance = deposit ? baseBalance_.add(baseDelta) : baseBalance_.sub(baseDelta);
        newQuoteBalance = deposit ? quoteBalance_.add(quoteDelta) : quoteBalance_.sub(quoteDelta);

        uint256 d1 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);

        uint256 difference = deposit ? d1.sub(d0) : d0.sub(d1);

        return difference.mul(lpSupply).div(d0);
    }

    function swap(
        uint256 version,
        uint256 baseOut,
        uint256 quoteOut,
        address to,
        bytes calldata data
    ) external override nonReentrant checkVersion(version) {
        require(baseOut > 0 || quoteOut > 0, "Insufficient output");
        (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(version);
        require(baseOut < baseBalance_ && quoteOut < quoteBalance_, "Insufficient liquidity");
        _update(baseBalance_, quoteBalance_);

        uint256 newBaseBalance;
        uint256 newQuoteBalance;
        uint256 fee;
        {
            address quoteAddress_ = quoteAddress;
            require(to != baseAddress() && to != quoteAddress_, "Invalid to address");
            if (baseOut > 0) IERC20(baseAddress()).safeTransfer(to, baseOut); // optimistically transfer tokens
            if (quoteOut > 0) IERC20(quoteAddress_).safeTransfer(to, quoteOut); // optimistically transfer tokens
            if (data.length > 0)
                ITranchessSwapCallee(to).tranchessSwapCallback(msg.sender, baseOut, quoteOut, data);
            newBaseBalance = IERC20(baseAddress()).balanceOf(address(this));
            newQuoteBalance = IERC20(quoteAddress_).balanceOf(address(this)).sub(totalAdminFee);
            fee = quoteOut.mul(feeRate).div(uint256(1e18).sub(feeRate));
        }
        uint256 baseIn =
            newBaseBalance > baseBalance_ - baseOut ? newBaseBalance - (baseBalance_ - baseOut) : 0;
        uint256 quoteIn =
            newQuoteBalance > quoteBalance_ - quoteOut
                ? newQuoteBalance - (quoteBalance_ - quoteOut)
                : 0;
        require(baseIn > 0 || quoteIn > 0, "Insufficient input");
        {
            fee = fee.add(quoteIn.multiplyDecimal(feeRate));
            uint256 ampl = getAmpl();
            uint256 newQuoteBalanceAdjusted = newQuoteBalance.sub(fee);
            uint256 oracle = checkOracle(Operation.SWAP);
            uint256 newD = _getD(newBaseBalance, newQuoteBalanceAdjusted, ampl, oracle);
            uint256 oldD = _getD(baseBalance_, quoteBalance_, ampl, oracle);
            // A D curve never intersects with other D curves, so D is strictly monotone given a nonnegative x.
            require(newD >= oldD, "Invariant mismatch");
        }
        emit Swap(msg.sender, baseOut, quoteOut, baseIn, quoteIn, to);
        fee = fee.multiplyDecimal(adminFeeRate);
        baseBalance = newBaseBalance;
        quoteBalance = newQuoteBalance.sub(fee);
        totalAdminFee = totalAdminFee.add(fee);
    }

    function _update(uint256 oldBaseBalance, uint256 oldQuoteBalance) private {
        uint256 timeElapsed = block.timestamp - blockTimestampLast; // overflow is desired
        if (timeElapsed > 0 && oldBaseBalance != 0 && oldQuoteBalance != 0) {
            // + overflow is desired
            baseCumulativeLast += oldQuoteBalance.mul(timeElapsed).divideDecimal(oldBaseBalance);
            quoteCumulativeLast += oldBaseBalance.mul(timeElapsed).divideDecimal(oldQuoteBalance);
        }
        blockTimestampLast = block.timestamp;
    }

    /// @dev Add liquidity.
    /// @param to Recipient
    /// @param minMintAmount Least amount of LP token to mint
    function addLiquidity(
        uint256 version,
        address to,
        uint256 minMintAmount
    ) external override nonReentrant checkVersion(version) {
        uint256 newBaseBalance = IERC20(baseAddress()).balanceOf(address(this));
        uint256 newQuoteBalance = IERC20(quoteAddress).balanceOf(address(this)).sub(totalAdminFee);
        uint256 ampl = getAmpl();
        uint256 fee;
        uint256 baseIn;
        uint256 quoteIn;
        uint256 d0;
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 oracle;
        {
            (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(version);
            _update(baseBalance_, quoteBalance_);
            baseIn = newBaseBalance > baseBalance_ ? newBaseBalance - baseBalance_ : 0;
            quoteIn = newQuoteBalance > quoteBalance_ ? newQuoteBalance - quoteBalance_ : 0;

            // Initial invariant
            oracle = checkOracle(Operation.ADD_LIQUIDITY);
            d0 = lpSupply == 0 ? 0 : _getD(baseBalance_, quoteBalance_, ampl, oracle);
        }

        if (lpSupply == 0) {
            require(baseIn > 0 && quoteIn > 0, "Stable: input amount has to be a positive value");
        }

        // Invariant after change
        uint256 d2;
        uint256 mintAmount;
        {
            uint256 d1 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);
            require(d1 > d0, "Stable: D1 should be higher than D0");

            d2 = d1;
            if (lpSupply > 0) {
                baseBalance = newBaseBalance;
                uint256 idealBalance = (d1 * quoteBalance) / d0;
                uint256 difference =
                    idealBalance > newQuoteBalance
                        ? idealBalance.sub(newQuoteBalance)
                        : newQuoteBalance.sub(idealBalance);

                fee = difference.multiplyDecimal(feeRate);
                quoteBalance = newQuoteBalance.sub(fee.multiplyDecimal(adminFeeRate));
                newQuoteBalance = newQuoteBalance.sub(fee);
                d2 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);
            } else {
                baseBalance = newBaseBalance;
                quoteBalance = newQuoteBalance;
            }

            mintAmount = lpSupply == 0 ? d1 : lpSupply.mul(d2.sub(d0)).div(d0);
            require(mintAmount >= minMintAmount, "Stable: exceed slippage tolerance interval");
        }

        // Mint pool tokens
        ILiquidityGauge(lpToken).mint(to, mintAmount);

        emit LiquidityAdded(msg.sender, baseIn, quoteIn, fee, d2, lpSupply.add(mintAmount));
    }

    /// @dev Remove liquidity proportionally.
    /// @param minBaseOut Least amount of base asset to withdraw
    /// @param minQuoteOut Least amount of quote asset to withdraw
    /// @param burnAmount Exact amount of LP token to burn
    function removeLiquidity(
        uint256 version,
        uint256 minBaseOut,
        uint256 minQuoteOut,
        uint256 burnAmount
    )
        public
        override
        nonReentrant
        checkVersion(version)
        returns (uint256 baseOut, uint256 quoteOut)
    {
        uint256 lpSupply = IERC20(lpToken).totalSupply();

        (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(version);
        _update(baseBalance_, quoteBalance_);
        baseOut = baseBalance_.mul(burnAmount).div(lpSupply);
        quoteOut = quoteBalance_.mul(burnAmount).div(lpSupply);
        require(baseOut >= minBaseOut, "Stable: drop below least tolerance amount");
        require(quoteOut >= minQuoteOut, "Stable: drop below least tolerance amount");

        baseBalance = baseBalance.sub(baseOut);
        quoteBalance = quoteBalance.sub(quoteOut);

        IERC20(baseAddress()).safeTransfer(msg.sender, baseOut);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteOut);

        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        emit LiquidityRemoved(msg.sender, baseOut, quoteOut, 0, lpSupply.sub(burnAmount));
    }

    /// @dev Remove liquidity arbitrarily.
    /// @param baseOut Exact amount of base asset to withdraw
    /// @param quoteOut Exact amount of quote asset to withdraw
    /// @param maxBurnAmount Most amount of LP token to burn
    function removeLiquidityImbalance(
        uint256 version,
        uint256 baseOut,
        uint256 quoteOut,
        uint256 maxBurnAmount
    ) public override nonReentrant checkVersion(version) returns (uint256 burnAmount) {
        uint256 ampl = getAmpl();
        uint256 newBaseBalance;
        uint256 newQuoteBalance;
        uint256 d0;
        uint256 oracle;
        uint256 idealBalance;
        {
            (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(version);
            oracle = checkOracle(Operation.VIEW);
            d0 = _getD(baseBalance_, quoteBalance_, ampl, oracle);
            _update(baseBalance_, quoteBalance_);
            newBaseBalance = baseBalance_.sub(baseOut);
            newQuoteBalance = quoteBalance_.sub(quoteOut);
            uint256 d1 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);
            idealBalance = (d1 * quoteBalance_) / d0;
        }

        uint256 difference =
            idealBalance > newQuoteBalance
                ? idealBalance.sub(newQuoteBalance)
                : newQuoteBalance.sub(idealBalance);

        uint256 fee = difference.mul(feeRate).div(uint256(1e18).sub(feeRate));
        baseBalance = newBaseBalance;
        quoteBalance = newQuoteBalance.sub(fee.multiplyDecimal(adminFeeRate));
        newQuoteBalance = newQuoteBalance.sub(fee);

        uint256 d2 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);

        burnAmount = d0.sub(d2).mul(IERC20(lpToken).totalSupply()).div(d0).add(1);
        require(burnAmount > 1, "Stable: no tokens burned");
        require(burnAmount <= maxBurnAmount, "Stable: exceed slippage tolerance interval");

        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        IERC20(baseAddress()).safeTransfer(msg.sender, baseOut);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteOut);

        emit LiquidityImbalanceRemoved(
            msg.sender,
            baseOut,
            quoteOut,
            fee,
            d2,
            IERC20(lpToken).totalSupply()
        );
    }

    /// @dev Remove base liquidity only.
    /// @param burnAmount Exact amount of LP token to burn
    /// @param minAmount Lesat amount of base asset to withdrawl
    function removeBaseLiquidity(
        uint256 version,
        uint256 burnAmount,
        uint256 minAmount
    ) public override nonReentrant checkVersion(version) returns (uint256) {
        uint256 ampl = getAmpl();
        uint256 oracle = checkOracle(Operation.VIEW);
        (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(version);
        uint256 d0 = _getD(baseBalance_, quoteBalance_, ampl, oracle);

        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 d1 = d0.sub(d0.mul(burnAmount).div(lpSupply));

        _update(baseBalance_, quoteBalance_);
        uint256 liquidityFee =
            quoteBalance_.sub(quoteBalance_.mul(d1).div(d0)).multiplyDecimal(feeRate);
        uint256 baseOut =
            baseBalance_.sub(_getBase(ampl, quoteBalance_.sub(liquidityFee), oracle, d1)).sub(1);
        require(baseOut >= minAmount, "Stable: not enough tokens to removed");

        baseBalance = baseBalance_.sub(baseOut);
        quoteBalance = quoteBalance_.sub(liquidityFee.multiplyDecimal(adminFeeRate));
        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        IERC20(baseAddress()).safeTransfer(msg.sender, baseOut);

        emit LiquiditySingleRemoved(msg.sender, burnAmount, baseOut);

        return baseOut;
    }

    /// @dev Remove quote liquidity only.
    /// @param burnAmount Exact amount of LP token to burn
    /// @param minAmount Lesat amount of quote asset to withdrawl
    function removeQuoteLiquidity(
        uint256 version,
        uint256 burnAmount,
        uint256 minAmount
    ) public override nonReentrant checkVersion(version) returns (uint256) {
        uint256 oracle = checkOracle(Operation.VIEW);
        (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(version);
        uint256 d0 = _getD(baseBalance_, quoteBalance_, getAmpl(), oracle);

        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 d1 = d0.sub(d0.mul(burnAmount).div(lpSupply));
        uint256 newQuoteBalance = _getQuote(getAmpl(), baseBalance, oracle, d1);

        _update(baseBalance_, quoteBalance_);
        uint256 liquidityFee =
            quoteBalance_.mul(d1).div(d0).sub(newQuoteBalance).multiplyDecimal(feeRate);
        uint256 quoteOut = quoteBalance_.sub(newQuoteBalance).sub(liquidityFee).sub(1);
        require(quoteOut >= minAmount, "Stable: not enough tokens to removed");

        quoteBalance = quoteBalance_.sub(quoteOut.add(liquidityFee.multiplyDecimal(adminFeeRate)));
        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        IERC20(quoteAddress).safeTransfer(msg.sender, quoteOut);

        emit LiquiditySingleRemoved(msg.sender, burnAmount, quoteOut);

        return quoteOut;
    }

    // force balances to match reserves
    function skim(address to) external nonReentrant {
        address baseAddress_ = baseAddress(); // gas savings
        address quoteAddress_ = quoteAddress; // gas savings
        (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(fund.getRebalanceSize());
        IERC20(baseAddress_).safeTransfer(
            to,
            IERC20(baseAddress_).balanceOf(address(this)).sub(baseBalance_)
        );
        IERC20(quoteAddress_).safeTransfer(
            to,
            IERC20(quoteAddress_).balanceOf(address(this)).sub(totalAdminFee).sub(quoteBalance_)
        );
    }

    // force reserves to match balances
    function sync() external nonReentrant {
        (uint256 baseBalance_, uint256 quoteBalance_) = _handleRebalance(fund.getRebalanceSize());
        _update(baseBalance_, quoteBalance_);
        uint256 newBaseBalance = IERC20(baseAddress()).balanceOf(address(this));
        uint256 newQuoteBalance = IERC20(quoteAddress).balanceOf(address(this)).sub(totalAdminFee);
        baseBalance = newBaseBalance;
        quoteBalance = newQuoteBalance;
        emit Sync(newBaseBalance, newQuoteBalance);
    }

    function collectFee() external {
        IERC20(quoteAddress).safeTransfer(feeCollector, totalAdminFee);
        delete totalAdminFee;
    }

    function _getD(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 oracle
    ) private pure returns (uint256) {
        // Solve D^3 + kxy(4A - 1)·D - 16Akxy(y + kx) = 0
        uint256 product = base.multiplyDecimal(quote);
        uint256 p = product.mul(16 * ampl - 4).multiplyDecimal(oracle);
        uint256 negQ =
            product
                .mul(16 * ampl)
                .multiplyDecimal(base.multiplyDecimal(oracle).add(quote))
                .multiplyDecimal(oracle);
        return solveDepressedCubic(p, negQ);
    }

    function _getBase(
        uint256 ampl,
        uint256 newQuoteBalance,
        uint256 oracle,
        uint256 d
    ) private pure returns (uint256 newBaseBalance) {
        // Solve 16Ayk^2·x^2 + 4ky(4Ay - 4AD + D)·x - D^3 = 0
        uint256 a = (16 * ampl * newQuoteBalance).multiplyDecimal(oracle).multiplyDecimal(oracle);
        uint256 b1 =
            (d.multiplyDecimal(newQuoteBalance * 4) +
                newQuoteBalance.mul(16 * ampl).multiplyDecimal(newQuoteBalance))
                .multiplyDecimal(oracle);
        uint256 b2 = d.multiplyDecimal(16 * ampl * newQuoteBalance).multiplyDecimal(oracle);
        uint256 negC = d.multiplyDecimal(d).multiplyDecimal(d);
        newBaseBalance = solveQuadratic(a, b1, b2, negC);
    }

    function _getQuote(
        uint256 ampl,
        uint256 newBaseBalance,
        uint256 oracle,
        uint256 d
    ) private pure returns (uint256 newQuoteBalance) {
        // Solve 16Axk·y^2 + 4kx(4Akx - 4AD + D)·y - D^3 = 0
        uint256 a = (16 * ampl * newBaseBalance).multiplyDecimal(oracle);
        uint256 b1 =
            (d.multiplyDecimal(newBaseBalance * 4) +
                newBaseBalance.mul(16 * ampl).multiplyDecimal(newBaseBalance).multiplyDecimal(
                    oracle
                ))
                .multiplyDecimal(oracle);
        uint256 b2 = d.multiplyDecimal(16 * ampl * newBaseBalance).multiplyDecimal(oracle);
        uint256 negC = d.multiplyDecimal(d).multiplyDecimal(d);
        newQuoteBalance = solveQuadratic(a, b1, b2, negC);
    }

    function _getBaseBalance(uint256 newQuoteBalance)
        private
        view
        returns (uint256 newBaseBalance)
    {
        // Calculate new asset balances
        uint256 ampl = getAmpl();
        uint256 oracle = checkOracle(Operation.VIEW);
        uint256 d = _getD(baseBalance, quoteBalance, ampl, oracle);
        newBaseBalance = _getBase(ampl, newQuoteBalance, oracle, d);
    }

    function _getQuoteBalance(uint256 newBaseBalance)
        private
        view
        returns (uint256 newQuoteBalance)
    {
        // Calculate new quote asset
        uint256 ampl = getAmpl();
        uint256 oracle = checkOracle(Operation.VIEW);
        uint256 d = _getD(baseBalance, quoteBalance, ampl, oracle);
        newQuoteBalance = _getQuote(ampl, newBaseBalance, oracle, d);
    }

    function solveDepressedCubic(uint256 p, uint256 negQ) public pure returns (uint256) {
        // Cardano's formula
        // For x^3 + px + q = 0, then the real root:
        // △ = q^2 / 4 + p^3 / 27
        // x = ∛(- q/2 + √△) + ∛(- q/2 - √△)
        uint256 delta =
            AdvancedMath.sqrt((p.mul(p).multiplyDecimal(p) / 27).add(negQ.mul(negQ) / 4));
        require(delta > 0, "wrong # of real root");

        return
            AdvancedMath.cbrt((delta + negQ / 2).mul(1e36)) -
            AdvancedMath.cbrt((delta - negQ / 2).mul(1e36));
    }

    function solveQuadratic(
        uint256 a,
        uint256 b1,
        uint256 b2,
        uint256 negC
    ) public pure returns (uint256) {
        // For ax^2 + bx + c = 0, then the positive root:
        // △ = b^2 - 4ac
        // x = (- b + √△) / 2a
        uint256 b = b1 < b2 ? b2 - b1 : b1 - b2;
        uint256 delta = b.mul(b).add(a.mul(negC).mul(4));
        require(a != 0, "invalid quadratic constant");
        require(delta >= 0, "invalid # of real root");

        return AdvancedMath.sqrt(delta).add(b2).sub(b1).mul(5e17).div(a);
    }

    /// @dev Check if the user-specified version is correct.
    modifier checkVersion(uint256 version) virtual {_;}

    /// @dev Compute the new base and quote amount after rebalanced to the latest version.
    ///      If any tokens should be distributed to LP holders, their amounts are also returned.
    ///
    ///      The latest rebalance version is passed in a parameter and it is caller's responsibility
    ///      to pass the correct version.
    /// @param latestVersion The latest rebalance version
    /// @return newBase Amount of base tokens after rebalance
    /// @return newQuote Amount of quote tokens after rebalance
    /// @return excessiveQ Amount of QUEEN that should be distributed to LP holders due to rebalance
    /// @return excessiveB Amount of BISHOP that should be distributed to LP holders due to rebalance
    /// @return excessiveR Amount of ROOK that should be distributed to LP holders due to rebalance
    /// @return excessiveQuote Amount of quote tokens that should be distributed to LP holders due to rebalance
    /// @return isRebalanced Whether the stored base and quote amount are rebalanced
    function _getRebalanceResult(uint256 latestVersion)
        internal
        view
        virtual
        returns (
            uint256 newBase,
            uint256 newQuote,
            uint256 excessiveQ,
            uint256 excessiveB,
            uint256 excessiveR,
            uint256 excessiveQuote,
            bool isRebalanced
        );

    /// @dev Update the stored base and quote balance to the latest rebalance version and distribute
    ///      any excessive tokens to LP holders.
    ///
    ///      The latest rebalance version is passed in a parameter and it is caller's responsibility
    ///      to pass the correct version.
    /// @param latestVersion The latest rebalance version
    /// @return newBase Amount of stored base tokens after rebalance
    /// @return newQuote Amount of stored quote tokens after rebalance
    function _handleRebalance(uint256 latestVersion)
        internal
        virtual
        returns (uint256 newBase, uint256 newQuote);

    function checkOracle(
        Operation /*op*/
    ) public view virtual returns (uint256 oracle) {
        return 1e18;
    }
}
