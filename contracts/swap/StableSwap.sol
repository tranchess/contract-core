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

abstract contract StableSwap is IStableSwap, ReentrancyGuard {
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
        uint256 adminFee
    );
    event LiquidityRemoved(
        address indexed account,
        uint256 lpIn,
        uint256 baseOut,
        uint256 quotOut,
        uint256 fee,
        uint256 adminFee
    );
    event Swap(
        address indexed sender,
        address indexed recipient,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 baseOut,
        uint256 quoteOut,
        uint256 fee,
        uint256 adminFee
    );
    event Sync(uint256 baseBalance, uint256 quoteBalance);

    uint256 private constant MIN_DIFF = 2;
    uint256 private constant MAX_ITERATION = 255;

    address public immutable lpToken;
    IFundV3 public immutable fund;
    uint256 public immutable baseTranche;
    address public immutable override quoteAddress;

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
        (uint256 base, uint256 quote, , , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        return (base, quote);
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

    function getCurrentD() external view override returns (uint256) {
        (uint256 base, uint256 quote, , , , , ) = _getRebalanceResult(fund.getRebalanceSize());
        return _getD(base, quote, getAmpl(), getOraclePrice());
    }

    function getD(
        uint256 base,
        uint256 quote,
        uint256 ampl,
        uint256 oraclePrice
    ) external pure override returns (uint256) {
        return _getD(base, quote, ampl, oraclePrice);
    }

    function getQuoteOut(uint256 baseIn) external view override returns (uint256 quoteOut) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 newBase = oldBase.add(baseIn);
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d = _getD(oldBase, oldQuote, ampl, oraclePrice);
        uint256 newQuote = _getQuote(ampl, newBase, oraclePrice, d);
        quoteOut = oldQuote.sub(newQuote).sub(1); // -1 just in case there were some rounding errors
        uint256 fee = quoteOut.multiplyDecimal(feeRate);
        quoteOut = quoteOut.sub(fee);
    }

    function getQuoteIn(uint256 baseOut) external view override returns (uint256 quoteIn) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 newBase = oldBase.sub(baseOut);
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d = _getD(oldBase, oldQuote, ampl, oraclePrice);
        uint256 newQuote = _getQuote(ampl, newBase, oraclePrice, d);
        quoteIn = newQuote.sub(oldQuote).add(1); // 1 just in case there were some rounding errors
        uint256 fee = quoteIn.mul(feeRate).div(uint256(1e18).sub(feeRate));
        quoteIn = quoteIn.add(fee);
    }

    function getBaseOut(uint256 quoteIn) external view override returns (uint256 baseOut) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 fee = quoteIn.multiplyDecimal(feeRate);
        uint256 newQuote = oldQuote.add(quoteIn.sub(fee));
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d = _getD(oldBase, oldQuote, ampl, oraclePrice);
        uint256 newBase = _getBase(ampl, newQuote, oraclePrice, d);
        baseOut = oldBase.sub(newBase).sub(1); // just in case there were rounding error
    }

    function getBaseIn(uint256 quoteOut) external view override returns (uint256 baseIn) {
        (uint256 oldBase, uint256 oldQuote, , , , , ) =
            _getRebalanceResult(fund.getRebalanceSize());
        uint256 fee = quoteOut.mul(feeRate).div(uint256(1e18).sub(feeRate));
        uint256 newQuote = oldQuote.sub(quoteOut.add(fee));
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d = _getD(oldBase, oldQuote, ampl, oraclePrice);
        uint256 newBase = _getBase(ampl, newQuote, oraclePrice, d);
        baseIn = newBase.sub(oldBase).add(1); // just in case there were rounding error
    }

    function buy(
        uint256 version,
        uint256 baseOut,
        address recipient,
        bytes calldata data
    ) external override nonReentrant checkVersion(version) {
        require(baseOut > 0, "Zero output");
        (uint256 oldBase, uint256 oldQuote) = _handleRebalance(version);
        require(baseOut < oldBase, "Insufficient liquidity");
        _update(oldBase, oldQuote);
        // Optimistically transfer tokens.
        IERC20(baseAddress()).safeTransfer(recipient, baseOut);
        if (data.length > 0) {
            ITranchessSwapCallee(msg.sender).tranchessSwapCallback(baseOut, 0, data);
        }
        uint256 newQuote = IERC20(quoteAddress).balanceOf(address(this)).sub(totalAdminFee);
        uint256 quoteIn = newQuote.sub(oldQuote);
        uint256 fee = quoteIn.multiplyDecimal(feeRate);
        {
            uint256 ampl = getAmpl();
            uint256 oraclePrice = getOraclePrice();
            uint256 oldD = _getD(oldBase, oldQuote, ampl, oraclePrice);
            uint256 newD = _getD(oldBase - baseOut, newQuote.sub(fee), ampl, oraclePrice);
            require(newD >= oldD, "Invariant mismatch");
        }
        uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
        baseBalance = oldBase - baseOut;
        quoteBalance = newQuote.sub(adminFee);
        totalAdminFee = totalAdminFee.add(adminFee);
        emit Swap(msg.sender, recipient, 0, quoteIn, baseOut, 0, fee, adminFee);
    }

    function sell(
        uint256 version,
        uint256 quoteOut,
        address recipient,
        bytes calldata data
    ) external override nonReentrant checkVersion(version) {
        require(quoteOut > 0, "Zero output");
        (uint256 oldBase, uint256 oldQuote) = _handleRebalance(version);
        _update(oldBase, oldQuote);
        // Optimistically transfer tokens.
        IERC20(quoteAddress).safeTransfer(recipient, quoteOut);
        if (data.length > 0) {
            ITranchessSwapCallee(msg.sender).tranchessSwapCallback(0, quoteOut, data);
        }
        uint256 newBase = IERC20(baseAddress()).balanceOf(address(this));
        uint256 baseIn = newBase.sub(oldBase);
        uint256 fee;
        {
            uint256 feeRate_ = feeRate;
            fee = quoteOut.mul(feeRate_).div(uint256(1e18).sub(feeRate_));
        }
        require(quoteOut.add(fee) < oldQuote, "Insufficient liquidity");
        {
            uint256 newQuote = oldQuote - quoteOut;
            uint256 ampl = getAmpl();
            uint256 oraclePrice = getOraclePrice();
            uint256 oldD = _getD(oldBase, oldQuote, ampl, oraclePrice);
            uint256 newD = _getD(newBase, newQuote - fee, ampl, oraclePrice);
            require(newD >= oldD, "Invariant mismatch");
        }
        uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
        baseBalance = newBase;
        quoteBalance = oldQuote - quoteOut - adminFee;
        totalAdminFee = totalAdminFee.add(adminFee);
        uint256 quoteOut_ = quoteOut;
        emit Swap(msg.sender, recipient, baseIn, 0, 0, quoteOut_, fee, adminFee);
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

    /// @notice Add liquidity. This function should be called by a smart contract, which transfers
    ///         base and quote tokens to this contract in the same transaction.
    /// @param version The latest rebalance version
    /// @param recipient Recipient of minted LP tokens
    /// @param lpOut Amount of minted LP tokens
    function addLiquidity(uint256 version, address recipient)
        external
        override
        nonReentrant
        checkVersion(version)
        returns (uint256 lpOut)
    {
        (uint256 oldBase, uint256 oldQuote) = _handleRebalance(version);
        _update(oldBase, oldQuote);
        uint256 newBase = IERC20(baseAddress()).balanceOf(address(this));
        uint256 newQuote = IERC20(quoteAddress).balanceOf(address(this)).sub(totalAdminFee);
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        if (lpSupply == 0) {
            require(newBase > 0 && newQuote > 0, "Zero initial balance");
            baseBalance = newBase;
            quoteBalance = newQuote;
            uint256 d1 = _getD(newBase, newQuote, ampl, oraclePrice);
            ILiquidityGauge(lpToken).mint(recipient, d1);
            emit LiquidityAdded(msg.sender, recipient, newBase, newQuote, d1, 0, 0);
            return d1;
        }
        uint256 fee;
        uint256 adminFee;
        {
            // Initial invariant
            uint256 d0 = _getD(oldBase, oldQuote, ampl, oraclePrice);
            {
                // New invariant before charging fee
                uint256 d1 = _getD(newBase, newQuote, ampl, oraclePrice);
                uint256 idealQuote = d1.mul(oldQuote) / d0;
                uint256 difference =
                    idealQuote > newQuote ? idealQuote - newQuote : newQuote - idealQuote;
                fee = difference.multiplyDecimal(feeRate);
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
            newBase - oldBase,
            newQuote - oldQuote,
            lpOut,
            fee,
            adminFee
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
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        (uint256 oldBase, uint256 oldQuote) = _handleRebalance(version);
        _update(oldBase, oldQuote);
        baseOut = oldBase.mul(lpIn).div(lpSupply);
        quoteOut = oldQuote.mul(lpIn).div(lpSupply);
        require(baseOut >= minBaseOut, "Insufficient output");
        require(quoteOut >= minQuoteOut, "Insufficient output");
        baseBalance = oldBase.sub(baseOut);
        quoteBalance = oldQuote.sub(quoteOut);
        ILiquidityGauge(lpToken).burnFrom(msg.sender, lpIn);
        IERC20(baseAddress()).safeTransfer(msg.sender, baseOut);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteOut);
        emit LiquidityRemoved(msg.sender, lpIn, baseOut, quoteOut, 0, 0);
    }

    /// @dev Remove base liquidity only.
    /// @param lpIn Exact amount of LP token to burn
    /// @param minBaseOut Lesat amount of base asset to withdrawl
    function removeBaseLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minBaseOut
    ) public override nonReentrant checkVersion(version) returns (uint256 baseOut) {
        (uint256 oldBase, uint256 oldQuote) = _handleRebalance(version);
        _update(oldBase, oldQuote);
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d1;
        {
            uint256 d0 = _getD(oldBase, oldQuote, ampl, oraclePrice);
            d1 = d0.sub(d0.mul(lpIn).div(lpSupply));
        }
        uint256 fee = oldQuote.mul(lpIn).div(lpSupply).multiplyDecimal(feeRate);
        uint256 newBase = _getBase(ampl, oldQuote.sub(fee), oraclePrice, d1).add(1);
        baseOut = oldBase.sub(newBase);
        require(baseOut >= minBaseOut, "Insufficient output");
        ILiquidityGauge(lpToken).burnFrom(msg.sender, lpIn);
        baseBalance = newBase;
        uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
        totalAdminFee = totalAdminFee.add(adminFee);
        quoteBalance = oldQuote.sub(adminFee);
        IERC20(baseAddress()).safeTransfer(msg.sender, baseOut);
        emit LiquidityRemoved(msg.sender, lpIn, baseOut, 0, fee, adminFee);
    }

    /// @dev Remove quote liquidity only.
    /// @param lpIn Exact amount of LP token to burn
    /// @param minQuoteOut Lesat amount of quote asset to withdrawl
    function removeQuoteLiquidity(
        uint256 version,
        uint256 lpIn,
        uint256 minQuoteOut
    ) public override nonReentrant checkVersion(version) returns (uint256 quoteOut) {
        (uint256 oldBase, uint256 oldQuote) = _handleRebalance(version);
        _update(oldBase, oldQuote);
        uint256 lpSupply = IERC20(lpToken).totalSupply();
        uint256 ampl = getAmpl();
        uint256 oraclePrice = getOraclePrice();
        uint256 d1;
        {
            uint256 d0 = _getD(oldBase, oldQuote, ampl, oraclePrice);
            d1 = d0.sub(d0.mul(lpIn).div(lpSupply));
        }
        uint256 idealQuote = oldQuote.mul(lpSupply.sub(lpIn)).div(lpSupply);
        uint256 newQuote = _getQuote(ampl, oldBase, oraclePrice, d1).add(1);
        uint256 fee = idealQuote.sub(newQuote).multiplyDecimal(feeRate);
        quoteOut = oldQuote.sub(newQuote).sub(fee);
        require(quoteOut >= minQuoteOut, "Insufficient output");
        ILiquidityGauge(lpToken).burnFrom(msg.sender, lpIn);
        uint256 adminFee = fee.multiplyDecimal(adminFeeRate);
        totalAdminFee = totalAdminFee.add(adminFee);
        quoteBalance = newQuote.add(fee).sub(adminFee);
        IERC20(quoteAddress).safeTransfer(msg.sender, quoteOut);
        emit LiquidityRemoved(msg.sender, lpIn, 0, quoteOut, fee, adminFee);
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
        uint256 oraclePrice
    ) private pure returns (uint256) {
        // Solve D^3 + kxy(4A - 1)·D - 16Akxy(y + kx) = 0
        uint256 product = base.multiplyDecimal(quote);
        uint256 p = product.mul(16 * ampl - 4).multiplyDecimal(oraclePrice);
        uint256 negQ =
            product
                .mul(16 * ampl)
                .multiplyDecimal(base.multiplyDecimal(oraclePrice).add(quote))
                .multiplyDecimal(oraclePrice);
        return solveDepressedCubic(p, negQ);
    }

    function _getBase(
        uint256 ampl,
        uint256 newQuoteBalance,
        uint256 oraclePrice,
        uint256 d
    ) private pure returns (uint256 newBaseBalance) {
        // Solve 16Ayk^2·x^2 + 4ky(4Ay - 4AD + D)·x - D^3 = 0
        uint256 a =
            (16 * ampl * newQuoteBalance).multiplyDecimal(oraclePrice).multiplyDecimal(oraclePrice);
        uint256 b1 =
            (d.multiplyDecimal(newQuoteBalance * 4) +
                newQuoteBalance.mul(16 * ampl).multiplyDecimal(newQuoteBalance))
                .multiplyDecimal(oraclePrice);
        uint256 b2 = d.multiplyDecimal(16 * ampl * newQuoteBalance).multiplyDecimal(oraclePrice);
        uint256 negC = d.multiplyDecimal(d).multiplyDecimal(d);
        newBaseBalance = solveQuadratic(a, b1, b2, negC);
    }

    function _getQuote(
        uint256 ampl,
        uint256 newBaseBalance,
        uint256 oraclePrice,
        uint256 d
    ) private pure returns (uint256 newQuoteBalance) {
        // Solve 16Axk·y^2 + 4kx(4Akx - 4AD + D)·y - D^3 = 0
        uint256 a = (16 * ampl * newBaseBalance).multiplyDecimal(oraclePrice);
        uint256 b1 =
            (d.multiplyDecimal(newBaseBalance * 4) +
                newBaseBalance.mul(16 * ampl).multiplyDecimal(newBaseBalance).multiplyDecimal(
                    oraclePrice
                ))
                .multiplyDecimal(oraclePrice);
        uint256 b2 = d.multiplyDecimal(16 * ampl * newBaseBalance).multiplyDecimal(oraclePrice);
        uint256 negC = d.multiplyDecimal(d).multiplyDecimal(d);
        newQuoteBalance = solveQuadratic(a, b1, b2, negC);
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

    function getOraclePrice() public view virtual override returns (uint256);
}
