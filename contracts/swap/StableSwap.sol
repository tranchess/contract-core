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
        uint256 baseDeltaOut,
        uint256 quoteDeltaOut,
        uint256 baseDeltaIn,
        uint256 quoteDeltaIn,
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

    address public primaryMarket;
    uint256 public currentRebalanceVersion;

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

        uint256 rebalanceVersion = IFundV3(fund_).getRebalanceSize();
        IFundV3(fund_).refreshBalance(address(this), rebalanceVersion);
        currentRebalanceVersion = rebalanceVersion;

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

    function Ampl() public view override returns (uint256) {
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

    function getCurrentD() public view override returns (uint256 D) {
        uint256 oracle = checkOracle(Operation.VIEW);
        D = _getD(baseBalance, quoteBalance, Ampl(), oracle);
    }

    function getD(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 oracle
    ) external view override returns (uint256 D) {
        return _getD(base, quote, ampl, oracle);
    }

    function getQuoteDeltaOut(uint256 baseDelta)
        public
        view
        override
        returns (
            uint256 quoteDelta,
            uint256 fee,
            uint256 adminFee
        )
    {
        uint256 newBaseBalance = baseBalance.add(baseDelta);
        uint256 newQuoteBalance = _getQuoteBalance(newBaseBalance);
        quoteDelta = quoteBalance.sub(newQuoteBalance).sub(1); // -1 just in case there were some rounding errors
        fee = quoteDelta.multiplyDecimal(feeRate);
        adminFee = fee.multiplyDecimal(adminFeeRate);
        quoteDelta = quoteDelta.sub(fee);
    }

    function getQuoteDeltaIn(uint256 baseDelta)
        public
        view
        override
        returns (
            uint256 quoteDelta,
            uint256 fee,
            uint256 adminFee
        )
    {
        uint256 newBaseBalance = baseBalance.sub(baseDelta);
        uint256 newQuoteBalance = _getQuoteBalance(newBaseBalance);
        quoteDelta = newQuoteBalance.sub(quoteBalance).add(1); // 1 just in case there were some rounding errors
        fee = quoteDelta.mul(feeRate).div(uint256(1e18).sub(feeRate));
        adminFee = fee.multiplyDecimal(adminFeeRate);
        quoteDelta = quoteDelta.add(fee);
    }

    function getBaseDeltaOut(uint256 quoteDelta)
        public
        view
        override
        returns (
            uint256 baseDelta,
            uint256 fee,
            uint256 adminFee
        )
    {
        fee = quoteDelta.multiplyDecimal(feeRate);
        adminFee = fee.multiplyDecimal(adminFeeRate);
        uint256 newQuoteBalance = quoteBalance.add(quoteDelta.sub(fee));
        uint256 newBaseBalance = _getBaseBalance(newQuoteBalance);
        baseDelta = baseBalance.sub(newBaseBalance).sub(1); // just in case there were rounding error
    }

    function getBaseDeltaIn(uint256 quoteDelta)
        public
        view
        override
        returns (
            uint256 baseDelta,
            uint256 fee,
            uint256 adminFee
        )
    {
        fee = quoteDelta.mul(feeRate).div(uint256(1e18).sub(feeRate));
        adminFee = fee.multiplyDecimal(adminFeeRate);
        uint256 newQuoteBalance = quoteBalance.sub(quoteDelta.add(fee));
        uint256 newBaseBalance = _getBaseBalance(newQuoteBalance);
        baseDelta = newBaseBalance.sub(baseBalance).add(1); // just in case there were rounding error
    }

    /// @dev Average asset value per LP token
    function virtualPrice() public view override returns (uint256) {
        uint256 D = getCurrentD();
        uint256 lpSupply = IERC20(lpToken).totalSupply();

        return D.divideDecimal(lpSupply);
    }

    /// @dev Estimate the amount of LP to mint/burn with a specified supply/withdraw distribution
    function calculateTokenAmount(
        uint256 baseDelta,
        uint256 quoteDelta,
        bool deposit
    ) public view override returns (uint256) {
        uint256 ampl = Ampl();
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 newBaseBalance;
        uint256 newQuoteBalance;
        uint256 baseBalance_ = baseBalance;
        uint256 quoteBalance_ = quoteBalance;
        uint256 oracle = checkOracle(Operation.VIEW);
        uint256 D0 = _getD(baseBalance_, quoteBalance_, ampl, oracle);

        newBaseBalance = deposit ? baseBalance_.add(baseDelta) : baseBalance_.sub(baseDelta);
        newQuoteBalance = deposit ? quoteBalance_.add(quoteDelta) : quoteBalance_.sub(quoteDelta);

        uint256 D1 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);

        uint256 difference = deposit ? D1.sub(D0) : D0.sub(D1);

        return difference.mul(lpSupply).div(D0);
    }

    /// @dev Handle the rebalance immediately. Should be called before any swap operation.
    function handleRebalance() public virtual override {}

    function swap(
        uint256 baseDeltaOut,
        uint256 quoteDeltaOut,
        address to,
        bytes calldata data
    ) external override nonReentrant checkActivity() {
        require(baseDeltaOut > 0 || quoteDeltaOut > 0, "Insufficient output");
        (uint256 baseBalance_, uint256 quoteBalance_) = allBalances();
        require(
            baseDeltaOut < baseBalance_ && quoteDeltaOut < quoteBalance_,
            "Insufficient liquidity"
        );
        _update(baseBalance_, quoteBalance_);

        uint256 newBaseBalance;
        uint256 newQuoteBalance;
        uint256 fee;
        {
            address quoteAddress_ = quoteAddress;
            require(to != baseAddress() && to != quoteAddress_, "Invalid to address");
            if (baseDeltaOut > 0) IERC20(baseAddress()).safeTransfer(to, baseDeltaOut); // optimistically transfer tokens
            if (quoteDeltaOut > 0) IERC20(quoteAddress_).safeTransfer(to, quoteDeltaOut); // optimistically transfer tokens
            if (data.length > 0)
                ITranchessSwapCallee(to).tranchessSwapCallback(
                    msg.sender,
                    baseDeltaOut,
                    quoteDeltaOut,
                    data
                );
            newBaseBalance = IERC20(baseAddress()).balanceOf(address(this));
            newQuoteBalance = IERC20(quoteAddress_).balanceOf(address(this)).sub(totalAdminFee);
            fee = quoteDeltaOut.mul(feeRate).div(uint256(1e18).sub(feeRate));
        }
        uint256 baseDeltaIn =
            newBaseBalance > baseBalance_ - baseDeltaOut
                ? newBaseBalance - (baseBalance_ - baseDeltaOut)
                : 0;
        uint256 quoteDeltaIn =
            newQuoteBalance > quoteBalance_ - quoteDeltaOut
                ? newQuoteBalance - (quoteBalance_ - quoteDeltaOut)
                : 0;
        require(baseDeltaIn > 0 || quoteDeltaIn > 0, "Insufficient input");
        {
            fee = fee.add(quoteDeltaIn.multiplyDecimal(feeRate));
            uint256 ampl = Ampl();
            uint256 newQuoteBalanceAdjusted = newQuoteBalance.sub(fee);
            uint256 oracle = checkOracle(Operation.SWAP);
            uint256 newD = _getD(newBaseBalance, newQuoteBalanceAdjusted, ampl, oracle);
            uint256 oldD = _getD(baseBalance_, quoteBalance_, ampl, oracle);
            // A D curve never intersects with other D curves, so D is strictly monotone given a nonnegative x.
            require(newD >= oldD, "Invariant mismatch");
        }
        emit Swap(msg.sender, baseDeltaOut, quoteDeltaOut, baseDeltaIn, quoteDeltaIn, to);
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
    function addLiquidity(address to, uint256 minMintAmount)
        external
        override
        nonReentrant
        checkActivity()
    {
        uint256 newBaseBalance = IERC20(baseAddress()).balanceOf(address(this));
        uint256 newQuoteBalance = IERC20(quoteAddress).balanceOf(address(this)).sub(totalAdminFee);
        uint256 ampl = Ampl();
        uint256 fee;
        uint256 baseDelta;
        uint256 quoteDelta;
        uint256 D0;
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 oracle;
        {
            (uint256 baseBalance_, uint256 quoteBalance_) = allBalances();
            _update(baseBalance_, quoteBalance_);
            baseDelta = newBaseBalance > baseBalance_ ? newBaseBalance - baseBalance_ : 0;
            quoteDelta = newQuoteBalance > quoteBalance_ ? newQuoteBalance - quoteBalance_ : 0;

            // Initial invariant
            oracle = checkOracle(Operation.ADD_LIQUIDITY);
            D0 = lpSupply == 0 ? 0 : _getD(baseBalance_, quoteBalance_, ampl, oracle);
        }

        if (lpSupply == 0) {
            require(
                baseDelta > 0 && quoteDelta > 0,
                "Stable: input amount has to be a positive value"
            );
        }

        // Invariant after change
        uint256 D2;
        uint256 mintAmount;
        {
            uint256 D1 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);
            require(D1 > D0, "Stable: D1 should be higher than D0");

            D2 = D1;
            if (lpSupply > 0) {
                baseBalance = newBaseBalance;
                uint256 idealBalance = (D1 * quoteBalance) / D0;
                uint256 difference =
                    idealBalance > newQuoteBalance
                        ? idealBalance.sub(newQuoteBalance)
                        : newQuoteBalance.sub(idealBalance);

                fee = difference.multiplyDecimal(feeRate);
                quoteBalance = newQuoteBalance.sub(fee.multiplyDecimal(adminFeeRate));
                newQuoteBalance = newQuoteBalance.sub(fee);
                D2 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);
            } else {
                baseBalance = newBaseBalance;
                quoteBalance = newQuoteBalance;
            }

            mintAmount = lpSupply == 0 ? D1 : lpSupply.mul(D2.sub(D0)).div(D0);
            require(mintAmount >= minMintAmount, "Stable: exceed slippage tolerance interval");
        }

        // Mint pool tokens
        ILiquidityGauge(lpToken).mint(to, mintAmount);

        emit LiquidityAdded(msg.sender, baseDelta, quoteDelta, fee, D2, lpSupply.add(mintAmount));
    }

    /// @dev Remove liquidity proportionally.
    /// @param minBaseDelta Least amount of base asset to withdraw
    /// @param minQuoteDelta Least amount of quote asset to withdraw
    /// @param burnAmount Exact amount of LP token to burn
    function removeLiquidity(
        uint256 minBaseDelta,
        uint256 minQuoteDelta,
        uint256 burnAmount
    ) public override nonReentrant returns (uint256 baseDelta, uint256 quoteDelta) {
        handleRebalance();
        uint256 lpSupply = IERC20(lpToken).totalSupply();

        (uint256 baseBalance_, uint256 quoteBalance_) = allBalances();
        _update(baseBalance_, quoteBalance_);
        baseDelta = baseBalance_.mul(burnAmount).div(lpSupply);
        quoteDelta = quoteBalance_.mul(burnAmount).div(lpSupply);
        require(baseDelta >= minBaseDelta, "Stable: drop below least tolerance amount");
        require(quoteDelta >= minQuoteDelta, "Stable: drop below least tolerance amount");

        baseBalance = baseBalance.sub(baseDelta);
        quoteBalance = quoteBalance.sub(quoteDelta);

        IERC20(baseAddress()).safeTransfer(msg.sender, baseDelta);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteDelta);

        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        emit LiquidityRemoved(msg.sender, baseDelta, quoteDelta, 0, lpSupply.sub(burnAmount));
    }

    /// @dev Remove liquidity arbitrarily.
    /// @param baseDelta Exact amount of base asset to withdraw
    /// @param quoteDelta Exact amount of quote asset to withdraw
    /// @param maxBurnAmount Most amount of LP token to burn
    function removeLiquidityImbalance(
        uint256 baseDelta,
        uint256 quoteDelta,
        uint256 maxBurnAmount
    ) public override nonReentrant returns (uint256 burnAmount) {
        handleRebalance();
        uint256 ampl = Ampl();
        uint256 newBaseBalance;
        uint256 newQuoteBalance;
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 D0;
        uint256 oracle;
        uint256 idealBalance;
        {
            (uint256 baseBalance_, uint256 quoteBalance_) = allBalances();
            oracle = checkOracle(Operation.VIEW);
            D0 = _getD(baseBalance_, quoteBalance_, ampl, oracle);
            _update(baseBalance_, quoteBalance_);
            newBaseBalance = baseBalance_.sub(baseDelta);
            newQuoteBalance = quoteBalance_.sub(quoteDelta);
            uint256 D1 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);
            idealBalance = (D1 * quoteBalance_) / D0;
        }

        uint256 difference =
            idealBalance > newQuoteBalance
                ? idealBalance.sub(newQuoteBalance)
                : newQuoteBalance.sub(idealBalance);

        uint256 fee = difference.mul(feeRate).div(uint256(1e18).sub(feeRate));
        baseBalance = newBaseBalance;
        quoteBalance = newQuoteBalance.sub(fee.multiplyDecimal(adminFeeRate));
        newQuoteBalance = newQuoteBalance.sub(fee);

        uint256 D2 = _getD(newBaseBalance, newQuoteBalance, ampl, oracle);

        burnAmount = D0.sub(D2).mul(lpSupply).div(D0).add(1);
        require(burnAmount > 1, "Stable: no tokens burned");
        require(burnAmount <= maxBurnAmount, "Stable: exceed slippage tolerance interval");

        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        IERC20(baseAddress()).safeTransfer(msg.sender, baseDelta);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteDelta);

        emit LiquidityImbalanceRemoved(
            msg.sender,
            baseDelta,
            quoteDelta,
            fee,
            D2,
            IERC20(lpToken).totalSupply()
        );
    }

    /// @dev Remove base liquidity only.
    /// @param burnAmount Exact amount of LP token to burn
    /// @param minAmount Lesat amount of base asset to withdrawl
    function removeBaseLiquidity(uint256 burnAmount, uint256 minAmount)
        public
        override
        nonReentrant
        returns (uint256)
    {
        handleRebalance();
        uint256 ampl = Ampl();
        uint256 oracle = checkOracle(Operation.VIEW);
        (uint256 baseBalance_, uint256 quoteBalance_) = allBalances();
        uint256 D0 = _getD(baseBalance_, quoteBalance_, ampl, oracle);

        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 D1 = D0.sub(D0.mul(burnAmount).div(lpSupply));

        _update(baseBalance_, quoteBalance_);
        uint256 liquidityFee =
            quoteBalance_.sub(quoteBalance_.mul(D1).div(D0)).multiplyDecimal(feeRate);
        uint256 baseDelta =
            baseBalance_.sub(_getBase(ampl, quoteBalance_.sub(liquidityFee), oracle, D1)).sub(1);
        require(baseDelta >= minAmount, "Stable: not enough tokens to removed");

        baseBalance = baseBalance_.sub(baseDelta);
        quoteBalance = quoteBalance_.sub(liquidityFee.multiplyDecimal(adminFeeRate));
        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        IERC20(baseAddress()).safeTransfer(msg.sender, baseDelta);

        emit LiquiditySingleRemoved(msg.sender, burnAmount, baseDelta);

        return baseDelta;
    }

    /// @dev Remove quote liquidity only.
    /// @param burnAmount Exact amount of LP token to burn
    /// @param minAmount Lesat amount of quote asset to withdrawl
    function removeQuoteLiquidity(uint256 burnAmount, uint256 minAmount)
        public
        override
        nonReentrant
        returns (uint256)
    {
        handleRebalance();
        uint256 ampl = Ampl();
        uint256 oracle = checkOracle(Operation.VIEW);
        (uint256 baseBalance_, uint256 quoteBalance_) = allBalances();
        uint256 D0 = _getD(baseBalance_, quoteBalance_, Ampl(), oracle);

        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 D1 = D0.sub(D0.mul(burnAmount).div(lpSupply));
        uint256 newQuoteBalance = _getQuote(ampl, baseBalance, oracle, D1);

        _update(baseBalance_, quoteBalance_);
        uint256 liquidityFee =
            quoteBalance_.mul(D1).div(D0).sub(newQuoteBalance).multiplyDecimal(feeRate);
        uint256 quoteDelta = quoteBalance_.sub(newQuoteBalance).sub(liquidityFee).sub(1);
        require(quoteDelta >= minAmount, "Stable: not enough tokens to removed");

        quoteBalance = quoteBalance_.sub(
            quoteDelta.add(liquidityFee.multiplyDecimal(adminFeeRate))
        );
        ILiquidityGauge(lpToken).burnFrom(msg.sender, burnAmount);

        IERC20(quoteAddress).safeTransfer(msg.sender, quoteDelta);

        emit LiquiditySingleRemoved(msg.sender, burnAmount, quoteDelta);

        return quoteDelta;
    }

    // force balances to match reserves
    function skim(address to) external nonReentrant {
        address baseAddress_ = baseAddress(); // gas savings
        address quoteAddress_ = quoteAddress; // gas savings
        IERC20(baseAddress_).safeTransfer(
            to,
            IERC20(baseAddress_).balanceOf(address(this)).sub(baseBalance)
        );
        IERC20(quoteAddress_).safeTransfer(
            to,
            IERC20(quoteAddress_).balanceOf(address(this)).sub(totalAdminFee).sub(quoteBalance)
        );
    }

    // force reserves to match balances
    function sync() external nonReentrant {
        _update(baseBalance, quoteBalance);
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
    ) private pure returns (uint256 D) {
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
        uint256 D
    ) private pure returns (uint256 newBaseBalance) {
        // Solve 16Ayk^2·x^2 + 4ky(4Ay - 4AD + D)·x - D^3 = 0
        uint256 a = (16 * ampl * newQuoteBalance).multiplyDecimal(oracle).multiplyDecimal(oracle);
        uint256 b1 =
            (D.multiplyDecimal(newQuoteBalance * 4) +
                newQuoteBalance.mul(16 * ampl).multiplyDecimal(newQuoteBalance))
                .multiplyDecimal(oracle);
        uint256 b2 = D.multiplyDecimal(16 * ampl * newQuoteBalance).multiplyDecimal(oracle);
        uint256 negC = D.multiplyDecimal(D).multiplyDecimal(D);
        newBaseBalance = solveQuadratic(a, b1, b2, negC);
    }

    function _getQuote(
        uint256 ampl,
        uint256 newBaseBalance,
        uint256 oracle,
        uint256 D
    ) private pure returns (uint256 newQuoteBalance) {
        // Solve 16Axk·y^2 + 4kx(4Akx - 4AD + D)·y - D^3 = 0
        uint256 a = (16 * ampl * newBaseBalance).multiplyDecimal(oracle);
        uint256 b1 =
            (D.multiplyDecimal(newBaseBalance * 4) +
                newBaseBalance.mul(16 * ampl).multiplyDecimal(newBaseBalance).multiplyDecimal(
                    oracle
                ))
                .multiplyDecimal(oracle);
        uint256 b2 = D.multiplyDecimal(16 * ampl * newBaseBalance).multiplyDecimal(oracle);
        uint256 negC = D.multiplyDecimal(D).multiplyDecimal(D);
        newQuoteBalance = solveQuadratic(a, b1, b2, negC);
    }

    function _getBaseBalance(uint256 newQuoteBalance)
        private
        view
        returns (uint256 newBaseBalance)
    {
        // Calculate new asset balances
        uint256 ampl = Ampl();
        uint256 oracle = checkOracle(Operation.VIEW);
        uint256 D = _getD(baseBalance, quoteBalance, ampl, oracle);
        newBaseBalance = _getBase(ampl, newQuoteBalance, oracle, D);
    }

    function _getQuoteBalance(uint256 newBaseBalance)
        private
        view
        returns (uint256 newQuoteBalance)
    {
        // Calculate new quote asset
        uint256 ampl = Ampl();
        uint256 oracle = checkOracle(Operation.VIEW);
        uint256 D = _getD(baseBalance, quoteBalance, ampl, oracle);
        newQuoteBalance = _getQuote(ampl, newBaseBalance, oracle, D);
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

    modifier checkActivity() virtual {_;}

    function checkOracle(
        Operation /*op*/
    ) public view virtual returns (uint256 oracle) {
        return 1e18;
    }
}
