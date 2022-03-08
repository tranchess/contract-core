// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../utils/SafeDecimalMath.sol";

import {DelayedRedemption, LibDelayedRedemption} from "./LibDelayedRedemption.sol";

import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/ITrancheIndex.sol";
import "../interfaces/IWrappedERC20.sol";

contract PrimaryMarketV3 is IPrimaryMarketV3, ReentrancyGuard, ITrancheIndex, Ownable {
    event Created(address indexed account, uint256 underlying, uint256 shares);
    event Redeemed(
        address indexed account,
        uint256 shares,
        uint256 underlying,
        uint256 redemptionFee
    );
    event Split(address indexed account, uint256 inM, uint256 outA, uint256 outB);
    event Merged(address indexed account, uint256 outM, uint256 inA, uint256 inB);
    event Claimed(address indexed account, uint256 createdShares, uint256 redeemedUnderlying);
    event Settled(
        uint256 indexed day,
        uint256 sharesToMint,
        uint256 sharesToBurn,
        uint256 creationUnderlying,
        uint256 redemptionUnderlying,
        uint256 fee
    );
    event RedemptionClaimable(uint256 indexed day);
    event FundCapUpdated(uint256 newCap);
    event RedemptionFeeRateUpdated(uint256 newRedemptionFeeRate);
    event SplitFeeRateUpdated(uint256 newSplitFeeRate);
    event MergeFeeRateUpdated(uint256 newMergeFeeRate);
    event MinCreationUnderlyingUpdated(uint256 newMinCreationUnderlying);

    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;
    using LibDelayedRedemption for DelayedRedemption;

    /// @dev Creation and redemption of a single account.
    /// @param day Day of the last creation or redemption request.
    /// @param creatingUnderlying Underlying that will be used for creation at the end of this day.
    /// @param redeemingShares Shares that will be redeemed at the end of this day.
    /// @param createdShares Shares already created in previous days.
    /// @param redeemedUnderlying Underlying already redeemed in previous days.
    /// @param version Rebalance version before the end of this trading day.
    struct CreationRedemption {
        uint256 day;
        uint256 creatingUnderlying;
        uint256 redeemingShares;
        uint256 createdShares;
        uint256 redeemedUnderlying;
        uint256 version;
    }

    uint256 private constant MAX_REDEMPTION_FEE_RATE = 0.01e18;
    uint256 private constant MAX_SPLIT_FEE_RATE = 0.01e18;
    uint256 private constant MAX_MERGE_FEE_RATE = 0.01e18;
    uint256 private constant MAX_ITERATIONS = 500;

    IFundV3 public immutable override fund;
    IERC20 private immutable _tokenUnderlying;

    uint256 public redemptionFeeRate;
    uint256 public splitFeeRate;
    uint256 public mergeFeeRate;
    uint256 public minCreationUnderlying;

    mapping(address => CreationRedemption) private _creationRedemptions;

    uint256 public currentDay;
    uint256 public currentCreatingUnderlying;
    uint256 public currentRedeemingShares;
    uint256 public currentFeeInShares;

    mapping(uint256 => uint256) private _historicalRedemptionRate;

    /// @notice The upper limit of underlying that the fund can hold. This contract rejects
    ///         creations that may break this limit.
    /// @dev This limit can be bypassed if the fund has multiple primary markets.
    ///
    ///      Set it to uint(-1) to skip the check and save gas.
    uint256 public fundCap;

    /// @notice The first trading day on which redemptions cannot be claimed now.
    uint256 public delayedRedemptionDay;

    /// @dev Mapping of trading day => total redeemed underlying if users cannot claim their
    ///      redemptions on that day, or zero otherwise.
    mapping(uint256 => uint256) private _delayedUnderlyings;

    /// @dev The total amount of redeemed underlying that can be claimed by users.
    uint256 private _claimableUnderlying;

    /// @dev Mapping of account => a list of redemptions that have been settled
    ///      but are not claimable yet.
    mapping(address => DelayedRedemption) private _delayedRedemptions;

    constructor(
        address fund_,
        uint256 redemptionFeeRate_,
        uint256 splitFeeRate_,
        uint256 mergeFeeRate_,
        uint256 minCreationUnderlying_,
        uint256 fundCap_
    ) public Ownable() {
        require(redemptionFeeRate_ <= MAX_REDEMPTION_FEE_RATE, "Exceed max redemption fee rate");
        require(splitFeeRate_ <= MAX_SPLIT_FEE_RATE, "Exceed max split fee rate");
        require(mergeFeeRate_ <= MAX_MERGE_FEE_RATE, "Exceed max merge fee rate");
        fund = IFundV3(fund_);
        _tokenUnderlying = IERC20(IFundV3(fund_).tokenUnderlying());
        redemptionFeeRate = redemptionFeeRate_;
        splitFeeRate = splitFeeRate_;
        mergeFeeRate = mergeFeeRate_;
        minCreationUnderlying = minCreationUnderlying_;
        currentDay = IFundV3(fund_).currentDay();
        fundCap = fundCap_;
        delayedRedemptionDay = currentDay;
    }

    /// @dev Unlike the previous version, this function updates states of the account and is not
    ///      "view" any more. To get the return value off-chain, please call this function
    ///      using `contract.creationRedemptionOf.call(account)` in web3
    ///      or `contract.callStatic.creationRedemptionOf(account)` in ethers.js.
    function creationRedemptionOf(address account) external returns (CreationRedemption memory) {
        _updateDelayedRedemptionDay();
        _updateUser(account);
        return _creationRedemptions[account];
    }

    /// @notice Return delayed redemption of an account on a trading day.
    /// @param account Address of the account
    /// @param day A trading day
    /// @return underlying Redeemed underlying amount
    /// @return nextDay Trading day of the next delayed redemption, or zero if there's no
    ///                 delayed redemption on the given day or it is the last redemption
    function getDelayedRedemption(address account, uint256 day)
        external
        view
        returns (uint256 underlying, uint256 nextDay)
    {
        return _delayedRedemptions[account].get(day);
    }

    /// @notice Return trading day of the first delayed redemption of an account.
    function getDelayedRedemptionHead(address account) external view returns (uint256) {
        return _delayedRedemptions[account].headTail.head;
    }

    function updateDelayedRedemptionDay() external override nonReentrant {
        _updateDelayedRedemptionDay();
    }

    function getRedemption(uint256 shares) public view override returns (uint256 underlying) {
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundTotalShares = fund.getTotalShares();
        underlying = shares.mul(fundUnderlying).div(fundTotalShares);
    }

    function getCreation(uint256 underlying) public view override returns (uint256 shares) {
        uint256 fundUnderlying = fund.getTotalUnderlying();
        uint256 fundTotalShares = fund.getTotalShares();
        require(underlying >= minCreationUnderlying, "Min amount");
        uint256 cap = fundCap;
        if (cap != uint256(-1)) {
            require(fundUnderlying.add(underlying) <= cap, "Exceed fund cap");
        }
        if (fundUnderlying == 0) {
            uint256 day = fund.currentDay();
            uint256 underlyingPrice = fund.twapOracle().getTwap(day);
            (uint256 prevNavM, , ) = fund.historicalNavs(day - 1 days);
            require(underlyingPrice != 0, "Underlying price for settlement is not ready yet");
            require(
                fundTotalShares == 0,
                "Cannot create shares for fund with shares but no underlying"
            );
            require(prevNavM > 0, "Cannot create shares at zero NAV");

            shares = underlying.mul(underlyingPrice).mul(fund.underlyingDecimalMultiplier()).div(
                prevNavM
            );
        } else {
            shares = underlying.mul(fundTotalShares).div(fundUnderlying);
        }
    }

    function getSplit(uint256 inM)
        public
        view
        override
        returns (
            uint256 outA,
            uint256 outB,
            uint256 feeM
        )
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        // Charge splitting fee and round it to a multiple of (weightA + weightB)
        uint256 unit = inM.sub(inM.multiplyDecimal(splitFeeRate)) / (weightA + weightB);
        require(unit > 0, "Too little to split");
        uint256 inMAfterFee = unit * (weightA + weightB);
        outA = unit * weightA;
        outB = inMAfterFee - outA;
        feeM = inM - inMAfterFee;
    }

    function getTokenAMForSplitB(uint256 outB)
        external
        view
        override
        returns (uint256 outA, uint256 inM)
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        outA = outB.mul(weightA) / weightB;
        uint256 inMAfterFee = outA.add(outB);
        inM = inMAfterFee.divideDecimal(uint256(1e18).sub(splitFeeRate)).add(1);
    }

    function getMerge(uint256 expectA)
        public
        view
        override
        returns (
            uint256 inA,
            uint256 inB,
            uint256 outM,
            uint256 feeM
        )
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        // Round to tranche weights
        uint256 unit = expectA / weightA;
        require(unit > 0, "Too little to merge");
        // Keep unmergable Token A unchanged.
        inA = unit * weightA;
        inB = unit.mul(weightB);
        uint256 outMBeforeFee = inA.add(inB);
        feeM = outMBeforeFee.multiplyDecimal(mergeFeeRate);
        outM = outMBeforeFee.sub(feeM);
    }

    function getTokenAMForMergeB(uint256 inB)
        external
        view
        override
        returns (uint256 inA, uint256 outM)
    {
        (uint256 weightA, uint256 weightB) = fund.trancheWeights();
        // Round to tranche weights
        uint256 unit = inB / weightB;
        require(unit > 0, "Too little to merge");
        // Keep unmergable Token A unchanged.
        inA = unit * weightA;
        inB = unit * weightB;
        uint256 outMBeforeFee = inA.add(inB);
        uint256 feeM = outMBeforeFee.multiplyDecimal(mergeFeeRate);
        outM = outMBeforeFee.sub(feeM);
    }

    function create(
        address recipient,
        uint256 underlying,
        uint256 version
    ) external override nonReentrant returns (uint256 shares) {
        shares = _create(recipient, underlying, version);
        _tokenUnderlying.safeTransferFrom(msg.sender, address(fund), underlying);
    }

    function wrapAndCreate(address recipient, uint256 version)
        external
        payable
        override
        nonReentrant
        returns (uint256 shares)
    {
        shares = _create(recipient, msg.value, version);
        IWrappedERC20(address(_tokenUnderlying)).deposit{value: msg.value}();
        _tokenUnderlying.safeTransfer(address(fund), msg.value);
    }

    function delayRedeem(
        address recipient,
        uint256 shares,
        uint256 version
    ) external override onlyActive nonReentrant {
        require(shares != 0, "Zero shares");
        // Use burn and mint to simulate a transfer, so that we don't need a special transferFrom()
        fund.burn(TRANCHE_M, msg.sender, shares, version);
        fund.mint(TRANCHE_M, address(this), shares, version);

        // Do not call `_updateDelayedRedemptionDay()` because the latest `redeemedUnderlying`
        // is not used in this function.
        _updateUser(recipient);
        CreationRedemption storage cr = _creationRedemptions[recipient];
        cr.redeemingShares = cr.redeemingShares.add(shares);
        currentRedeemingShares = currentRedeemingShares.add(shares);

        emit Redeemed(recipient, shares, 0, 0);
    }

    function redeem(
        address recipient,
        uint256 shares,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(recipient, shares, version);
    }

    function redeemAndUnwrap(
        address recipient,
        uint256 shares,
        uint256 version
    ) external override nonReentrant returns (uint256 underlying) {
        underlying = _redeem(address(this), shares, version);
        IWrappedERC20(address(_tokenUnderlying)).withdraw(underlying);
        (bool success, ) = recipient.call{value: underlying}("");
        require(success, "Transfer failed");
    }

    function _create(
        address recipient,
        uint256 underlying,
        uint256 version
    ) private onlyActive returns (uint256 shares) {
        _updateUser(recipient);
        shares = getCreation(underlying);
        fund.mint(TRANCHE_M, recipient, shares, version);

        emit Created(recipient, underlying, shares);
    }

    function _redeem(
        address recipient,
        uint256 shares,
        uint256 version
    ) private onlyActive returns (uint256 redeemedUnderlying) {
        require(shares != 0, "Zero shares");
        require(delayedRedemptionDay == currentDay);
        _updateUser(recipient);
        fund.burn(TRANCHE_M, msg.sender, shares, version);
        uint256 underlying = getRedemption(shares);
        uint256 balance = _tokenUnderlying.balanceOf(address(fund));
        require(underlying <= balance, "Not enough available hot balance");
        uint256 redemptionFee = underlying.multiplyDecimal(redemptionFeeRate);
        redeemedUnderlying = underlying.sub(redemptionFee);
        fund.transferToPrimaryMarket(recipient, redeemedUnderlying, redemptionFee);

        emit Redeemed(recipient, shares, redeemedUnderlying, redemptionFee);
    }

    function claim(address account)
        external
        override
        nonReentrant
        returns (uint256 createdShares, uint256 redeemedUnderlying)
    {
        (createdShares, redeemedUnderlying) = _claim(account);
        if (createdShares > 0) {
            IERC20(fund.tokenM()).safeTransfer(account, createdShares);
        }
        if (redeemedUnderlying > 0) {
            _tokenUnderlying.safeTransfer(account, redeemedUnderlying);
        }
    }

    function claimAndUnwrap(address account)
        external
        override
        nonReentrant
        returns (uint256 createdShares, uint256 redeemedUnderlying)
    {
        (createdShares, redeemedUnderlying) = _claim(account);
        if (createdShares > 0) {
            IERC20(fund.tokenM()).safeTransfer(account, createdShares);
        }
        if (redeemedUnderlying > 0) {
            IWrappedERC20(address(_tokenUnderlying)).withdraw(redeemedUnderlying);
            (bool success, ) = account.call{value: redeemedUnderlying}("");
            require(success, "Transfer failed");
        }
    }

    function _claim(address account)
        private
        returns (uint256 createdShares, uint256 redeemedUnderlying)
    {
        _updateDelayedRedemptionDay();
        _updateUser(account);
        CreationRedemption storage cr = _creationRedemptions[account];
        createdShares = cr.createdShares;
        redeemedUnderlying = cr.redeemedUnderlying;

        if (createdShares > 0) {
            cr.createdShares = 0;
        }
        if (redeemedUnderlying > 0) {
            _claimableUnderlying = _claimableUnderlying.sub(redeemedUnderlying);
            cr.redeemedUnderlying = 0;
        }

        emit Claimed(account, createdShares, redeemedUnderlying);
        return (createdShares, redeemedUnderlying);
    }

    function split(
        address recipient,
        uint256 inM,
        uint256 version
    ) external override onlyActive returns (uint256 outA, uint256 outB) {
        uint256 feeM;
        (outA, outB, feeM) = getSplit(inM);

        fund.burn(TRANCHE_M, msg.sender, inM, version);
        fund.mint(TRANCHE_A, recipient, outA, version);
        fund.mint(TRANCHE_B, recipient, outB, version);
        fund.mint(TRANCHE_M, address(this), feeM, version);

        currentFeeInShares = currentFeeInShares.add(feeM);
        emit Split(msg.sender, inM, outA, outB);
    }

    function merge(
        address recipient,
        uint256 inA,
        uint256 version
    ) external override onlyActive returns (uint256 inB, uint256 outM) {
        uint256 feeM;
        (inA, inB, outM, feeM) = getMerge(inA);
        fund.burn(TRANCHE_A, msg.sender, inA, version);
        fund.burn(TRANCHE_B, msg.sender, inB, version);
        fund.mint(TRANCHE_M, recipient, outM, version);
        fund.mint(TRANCHE_M, address(this), feeM, version);

        currentFeeInShares = currentFeeInShares.add(feeM);
        emit Merged(msg.sender, outM, inA, inB);
    }

    /// @notice Settle ongoing creations and redemptions and also split and merge fees.
    ///
    ///         Creations and redemptions are settled according to the current shares and
    ///         underlying assets in the fund. Split and merge fee charged as Token M are also
    ///         redeemed at the same rate (without redemption fee).
    ///
    ///         This function does not mint or burn shares, nor transfer underlying assets.
    ///         It returns the following changes that should be done by the fund:
    ///
    ///         1. Mint or burn net shares (creations v.s. redemptions + split/merge fee).
    ///         2. Transfer underlying to or from this contract (creations v.s. redemptions).
    ///         3. Transfer fee in underlying assets to the governance address.
    ///
    ///         This function can only be called from the Fund contract. It should be called
    ///         after protocol fee is collected and before rebalance is triggered for the same
    ///         trading day.
    /// @param day The trading day to settle
    /// @param fundTotalShares Total shares of the fund (as if all Token A and B are merged)
    /// @param fundUnderlying Underlying assets in the fund
    /// @return sharesToMint Amount of Token M to mint for creations
    /// @return sharesToBurn Amount of Token M to burn for redemptions and split/merge fee
    /// @return creationUnderlying Underlying assets received for creations (including creation fee)
    /// @return redemptionUnderlying Underlying assets to be redeemed (excluding redemption fee)
    /// @return fee Total fee in underlying assets for the fund to transfer to the governance address,
    ///         inlucding creation fee, redemption fee and split/merge fee
    function settle(
        uint256 day,
        uint256 fundTotalShares,
        uint256 fundUnderlying,
        uint256, /*underlyingPrice*/
        uint256 /*previousNav*/
    )
        external
        override
        nonReentrant
        onlyFund
        returns (
            uint256 sharesToMint,
            uint256 sharesToBurn,
            uint256 creationUnderlying,
            uint256 redemptionUnderlying,
            uint256 fee
        )
    {
        require(day >= currentDay, "Already settled");

        // Redemption
        sharesToBurn = currentRedeemingShares;
        if (sharesToBurn > 0) {
            uint256 underlying = sharesToBurn.mul(fundUnderlying).div(fundTotalShares);
            uint256 redemptionFee = underlying.multiplyDecimal(redemptionFeeRate);
            redemptionUnderlying = underlying.sub(redemptionFee);
            _historicalRedemptionRate[day] = redemptionUnderlying.divideDecimal(sharesToBurn);
            fee = redemptionFee;
        }

        // Redeem split and merge fee
        uint256 feeInShares = currentFeeInShares;
        if (feeInShares > 0) {
            sharesToBurn = sharesToBurn.add(feeInShares);
            fee = fee.add(feeInShares.mul(fundUnderlying).div(fundTotalShares));
        }

        // This loop should never execute, because this function is called by Fund
        // for every day. We fill the gap just in case that something goes wrong in Fund.
        for (uint256 t = currentDay; t < day; t += 1 days) {
            _historicalRedemptionRate[t] = _historicalRedemptionRate[day];
        }

        _delayedUnderlyings[day] = redemptionUnderlying;
        currentDay = day + 1 days;
        currentRedeemingShares = 0;
        currentFeeInShares = 0;
        emit Settled(
            day,
            sharesToMint,
            sharesToBurn,
            creationUnderlying,
            redemptionUnderlying,
            fee
        );
    }

    function updateFundCap(uint256 newCap) external onlyOwner {
        fundCap = newCap;
        emit FundCapUpdated(newCap);
    }

    function updateRedemptionFeeRate(uint256 newRedemptionFeeRate) external onlyOwner {
        require(newRedemptionFeeRate <= MAX_REDEMPTION_FEE_RATE, "Exceed max redemption fee rate");
        redemptionFeeRate = newRedemptionFeeRate;
        emit RedemptionFeeRateUpdated(newRedemptionFeeRate);
    }

    function updateSplitFeeRate(uint256 newSplitFeeRate) external onlyOwner {
        require(newSplitFeeRate <= MAX_SPLIT_FEE_RATE, "Exceed max split fee rate");
        splitFeeRate = newSplitFeeRate;
        emit SplitFeeRateUpdated(newSplitFeeRate);
    }

    function updateMergeFeeRate(uint256 newMergeFeeRate) external onlyOwner {
        require(newMergeFeeRate <= MAX_MERGE_FEE_RATE, "Exceed max merge fee rate");
        mergeFeeRate = newMergeFeeRate;
        emit MergeFeeRateUpdated(newMergeFeeRate);
    }

    function updateMinCreationUnderlying(uint256 newMinCreationUnderlying) external onlyOwner {
        minCreationUnderlying = newMinCreationUnderlying;
        emit MinCreationUnderlyingUpdated(newMinCreationUnderlying);
    }

    /// @dev Update the status of an account.
    ///      1. If there is a pending creation before the last settlement, calculate its result
    ///         and add it to `createdShares`.
    ///      2. If there is a pending redemption before the last settlement, calculate its result.
    ///         Add the result to `redeemedUnderlying` if it can be claimed now. Otherwise, append
    ///         the result to the account's delayed redemption list.
    ///      3. Check the account's delayed redemption list. Remove the redemptions that can be
    ///         claimed now from the list and add them to `redeemedUnderlying`. Note that
    ///         if `_updateDelayedRedemptionDay()` is not called before this function, some
    ///         claimable redemption may not be correctly recognized and `redeemedUnderlying` may
    ///         be smaller than the actual amount that the user can claim.
    function _updateUser(address account) private {
        CreationRedemption storage cr = _creationRedemptions[account];
        uint256 oldDay = cr.day;
        uint256 newDay = currentDay;
        if (oldDay < newDay) {
            cr.day = newDay;
            uint256 oldRedeemingShares = cr.redeemingShares;
            if (oldRedeemingShares > 0) {
                uint256 underlying =
                    oldRedeemingShares.multiplyDecimal(_historicalRedemptionRate[oldDay]);
                cr.redeemingShares = 0;
                if (oldDay < delayedRedemptionDay) {
                    cr.redeemedUnderlying = cr.redeemedUnderlying.add(underlying);
                } else {
                    _delayedRedemptions[account].pushBack(underlying, oldDay);
                }
            }
        }

        uint256 delayedUnderlying =
            _delayedRedemptions[account].popFrontUntil(delayedRedemptionDay - 1 days);
        if (delayedUnderlying > 0) {
            cr.redeemedUnderlying = cr.redeemedUnderlying.add(delayedUnderlying);
        }
    }

    /// @dev Move `delayedRedemptionDay` forward when there are enough underlying tokens in
    ///      this contract.
    function _updateDelayedRedemptionDay() private returns (uint256) {
        uint256 oldDelayedRedemptionDay = delayedRedemptionDay;
        uint256 currentDay_ = currentDay;
        if (oldDelayedRedemptionDay >= currentDay_) {
            return oldDelayedRedemptionDay; // Fast path to return
        }
        uint256 newDelayedRedemptionDay = oldDelayedRedemptionDay;
        uint256 claimableUnderlying = _claimableUnderlying;
        uint256 balance = _tokenUnderlying.balanceOf(address(this)).sub(claimableUnderlying);
        for (uint256 i = 0; i < MAX_ITERATIONS && newDelayedRedemptionDay < currentDay_; i++) {
            uint256 underlying = _delayedUnderlyings[newDelayedRedemptionDay];
            if (underlying > balance) {
                break;
            }
            balance -= underlying;
            claimableUnderlying = claimableUnderlying.add(underlying);
            emit RedemptionClaimable(newDelayedRedemptionDay);
            newDelayedRedemptionDay += 1 days;
        }
        if (newDelayedRedemptionDay != oldDelayedRedemptionDay) {
            delayedRedemptionDay = newDelayedRedemptionDay;
            _claimableUnderlying = claimableUnderlying;
        }
        return newDelayedRedemptionDay;
    }

    /// @notice Receive unwrapped transfer from the wrapped token.
    receive() external payable {}

    modifier onlyActive() {
        require(fund.isPrimaryMarketActive(address(this), block.timestamp), "Only when active");
        _;
    }

    modifier onlyFund() {
        require(msg.sender == address(fund), "Only fund");
        _;
    }
}
