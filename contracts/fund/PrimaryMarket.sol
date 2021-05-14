// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../utils/SafeDecimalMath.sol";

import "../interfaces/IPrimaryMarket.sol";
import "../interfaces/ITwapOracle.sol";
import "../interfaces/IFund.sol";
import "../interfaces/ITrancheIndex.sol";

contract PrimaryMarket is IPrimaryMarket, ReentrancyGuard, ITrancheIndex {
    event Created(address indexed account, uint256 underlying);
    event Redeemed(address indexed account, uint256 shares);
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

    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    /// @dev Creation and redemption of a single account.
    /// @param day Day of the last creation or redemption request.
    /// @param creatingUnderlying Underlying that will be used for creation at the end of this day.
    /// @param redeemingShares Shares that will be redeemed at the end of this day.
    /// @param createdShares Shares already created in previous days.
    /// @param redeemedUnderlying Underlying already redeemed in previous days.
    /// @param conversionIndex Conversion index before the end of this day.
    struct CreationRedemption {
        uint256 day;
        uint256 creatingUnderlying;
        uint256 redeemingShares;
        uint256 createdShares;
        uint256 redeemedUnderlying;
        uint256 conversionIndex;
    }

    IFund public fund;

    uint256 public creationFeeRate;
    uint256 public redemptionFeeRate;
    uint256 public splitFeeRate;
    uint256 public mergeFeeRate;
    uint256 public minCreationUnderlying;

    mapping(address => CreationRedemption) private _creationRedemptions;

    uint256 public currentDay;
    uint256 public currentCreatingUnderlying;
    uint256 public currentRedeemingShares;
    uint256 public currentFeeInShares;

    mapping(uint256 => uint256) private _historyCreationRate;
    mapping(uint256 => uint256) private _historyRedemptionRate;

    constructor(
        address fund_,
        uint256 creationFeeRate_,
        uint256 redemptionFeeRate_,
        uint256 splitFeeRate_,
        uint256 mergeFeeRate_,
        uint256 minCreationUnderlying_
    ) public {
        fund = IFund(fund_);
        creationFeeRate = creationFeeRate_;
        redemptionFeeRate = redemptionFeeRate_;
        splitFeeRate = splitFeeRate_;
        mergeFeeRate = mergeFeeRate_;
        minCreationUnderlying = minCreationUnderlying_;
        currentDay = fund.currentDay();
    }

    function creationRedemptionOf(address account)
        external
        view
        returns (CreationRedemption memory)
    {
        return _currentCreationRedemption(account);
    }

    function create(uint256 underlying) external nonReentrant onlyActive {
        require(underlying >= minCreationUnderlying, "min amount");
        require(
            IERC20(fund.tokenUnderlying()).transferFrom(msg.sender, address(this), underlying),
            "tokenUnderlying failed transferFrom"
        );

        CreationRedemption memory cr = _currentCreationRedemption(msg.sender);
        cr.creatingUnderlying = cr.creatingUnderlying.add(underlying);
        _updateCreationRedemption(msg.sender, cr);

        currentCreatingUnderlying = currentCreatingUnderlying.add(underlying);

        emit Created(msg.sender, underlying);
    }

    function redeem(uint256 shares) external onlyActive {
        require(shares != 0, "Zero shares");
        // Use burn and mint to simulate a transfer, so that we don't need a special transferFrom()
        fund.burn(TRANCHE_M, msg.sender, shares);
        fund.mint(TRANCHE_M, address(this), shares);

        CreationRedemption memory cr = _currentCreationRedemption(msg.sender);
        cr.redeemingShares = cr.redeemingShares.add(shares);
        _updateCreationRedemption(msg.sender, cr);

        currentRedeemingShares = currentRedeemingShares.add(shares);
        emit Redeemed(msg.sender, shares);
    }

    function claim(address account)
        external
        override
        nonReentrant
        returns (uint256 createdShares, uint256 redeemedUnderlying)
    {
        CreationRedemption memory cr = _currentCreationRedemption(account);
        createdShares = cr.createdShares;
        redeemedUnderlying = cr.redeemedUnderlying;

        if (createdShares > 0) {
            IERC20(fund.tokenM()).transfer(account, createdShares);
            cr.createdShares = 0;
        }
        if (redeemedUnderlying > 0) {
            require(
                IERC20(fund.tokenUnderlying()).transfer(account, redeemedUnderlying),
                "tokenUnderlying failed transfer"
            );
            cr.redeemedUnderlying = 0;
        }
        _updateCreationRedemption(account, cr);

        emit Claimed(account, createdShares, redeemedUnderlying);
    }

    function split(uint256 inM) external onlyActive {
        (uint256 weightA, uint256 weightB) = fund.splitWeights();
        // Charge splitting fee and round it to a multiple of (weightA + weightB)
        uint256 unit = inM.sub(inM.multiplyDecimal(splitFeeRate)) / (weightA + weightB);
        require(unit > 0, "Too little to split");
        uint256 inPAfterFee = unit * (weightA + weightB);
        uint256 outA = unit * weightA;
        uint256 outB = inPAfterFee - outA;
        uint256 feeM = inM - inPAfterFee;

        fund.burn(TRANCHE_M, msg.sender, inM);
        fund.mint(TRANCHE_A, msg.sender, outA);
        fund.mint(TRANCHE_B, msg.sender, outB);
        fund.mint(TRANCHE_M, address(this), feeM);

        currentFeeInShares = currentFeeInShares.add(feeM);
        emit Split(msg.sender, inM, outA, outA);
    }

    function merge(uint256 inA) external onlyActive {
        (uint256 weightA, uint256 weightB) = fund.splitWeights();
        // Round to share weights
        uint256 unit = inA / weightA;
        require(unit > 0, "Too little to merge");
        // Keep unmergable A shares unchanged.
        inA = unit * weightA;
        uint256 inB = unit.mul(weightB);
        uint256 outPBeforeFee = inA.add(inB);
        uint256 feeM = outPBeforeFee.multiplyDecimal(mergeFeeRate);
        uint256 outM = outPBeforeFee.sub(feeM);

        fund.burn(TRANCHE_A, msg.sender, inA);
        fund.burn(TRANCHE_B, msg.sender, inB);
        fund.mint(TRANCHE_M, msg.sender, outM);
        fund.mint(TRANCHE_M, address(this), feeM);

        currentFeeInShares = currentFeeInShares.add(feeM);
        emit Merged(msg.sender, outM, inA, inB);
    }

    /// @notice Settle ongoing creations and redemptions and also split and merge fees.
    ///
    ///         Creations and redemptions are settled according to the current shares and
    ///         underlying assets in the fund. Split and merge fee charged as M shares are also
    ///         redeemed at the same rate (without no redemption fee).
    ///
    ///         This function does not mint or burn shares, nor transfer underlying assets.
    ///         It returns the following changes that should be done by the fund:
    ///
    ///         1. Mint or burn net shares (creations v.s. redemptions + split/merge fee).
    ///         2. Transfer underlying to or from this contract (creations v.s. redemptions).
    ///         3. Transfer fee in underlying assets to the governance address.
    ///
    ///         This function can only be called from the Fund contract. It should be called
    ///         after management fee is collected and before conversion is triggered for the same
    ///         trading day.
    /// @param day The trading day to settle
    /// @param fundTotalShares Total shares of the fund (as if all A and B shares are merged)
    /// @param fundUnderlying Underlying assets in the fund
    /// @param underlyingPrice Price of the underlying assets at the end of the trading day
    /// @param previousNav NAV of Share M of the previous trading day
    /// @return sharesToMint Amount of Share M to mint for creations
    /// @return sharesToBurn Amount of Share M to burn for redemptions and split/merge fee
    /// @return creationUnderlying Underlying assets received for creations (including creation fee)
    /// @return redemptionUnderlying Underlying assets to be redeemed (excluding redemption fee)
    /// @return fee Total fee in underlying assets for the fund to transfer to the governance address,
    ///         inlucding creation fee, redemption fee and split/merge fee
    function settle(
        uint256 day,
        uint256 fundTotalShares,
        uint256 fundUnderlying,
        uint256 underlyingPrice,
        uint256 previousNav
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

        // Creation
        creationUnderlying = currentCreatingUnderlying;
        if (creationUnderlying > 0) {
            uint256 creationFee = creationUnderlying.multiplyDecimal(creationFeeRate);
            if (fundUnderlying > 0) {
                sharesToMint = creationUnderlying.sub(creationFee).mul(fundTotalShares).div(
                    fundUnderlying
                );
            } else {
                // NAV is rounded down. Computing creations using NAV results in rounded up shares,
                // which is unfair to existing share holders. We only do that when there are
                // no shares before.
                require(
                    fundTotalShares == 0,
                    "Cannot create shares for fund with shares but no underlying"
                );
                require(previousNav > 0, "Cannot create shares at zero NAV");
                sharesToMint = creationUnderlying
                    .sub(creationFee)
                    .mul(underlyingPrice)
                    .mul(fund.underlyingDecimalMultiplier())
                    .div(previousNav);
            }
            _historyCreationRate[day] = sharesToMint.divideDecimal(creationUnderlying);
            fee = creationFee;
        }

        // Redemption
        sharesToBurn = currentRedeemingShares;
        if (sharesToBurn > 0) {
            uint256 underlying = sharesToBurn.mul(fundUnderlying).div(fundTotalShares);
            uint256 redemptionFee = underlying.multiplyDecimal(redemptionFeeRate);
            redemptionUnderlying = underlying.sub(redemptionFee);
            _historyRedemptionRate[day] = redemptionUnderlying.divideDecimal(sharesToBurn);
            fee = fee.add(redemptionFee);
        }

        // Redeem split and merge fee
        uint256 feeInShares = currentFeeInShares;
        if (feeInShares > 0) {
            sharesToBurn = sharesToBurn.add(feeInShares);
            fee = fee.add(feeInShares.mul(fundUnderlying).div(fundTotalShares));
        }

        // Approve the fund to take underlying if creation is more than redemption.
        // Instead of directly transfering underlying to the fund, this implementation
        // makes testing much easier.
        if (creationUnderlying > redemptionUnderlying) {
            require(
                IERC20(fund.tokenUnderlying()).approve(
                    address(fund),
                    creationUnderlying - redemptionUnderlying
                ),
                "tokenUnderlying failed approve"
            );
        }

        // This loop should never execute, because this function is called by Fund
        // for every day. We fill the gap just in case that something goes wrong in Fund.
        for (uint256 t = currentDay; t < day; t += 1 days) {
            _historyCreationRate[t] = _historyCreationRate[day];
            _historyRedemptionRate[t] = _historyRedemptionRate[day];
        }

        currentDay = day + 1 days;
        currentCreatingUnderlying = 0;
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

    function _currentCreationRedemption(address account)
        private
        view
        returns (CreationRedemption memory cr)
    {
        cr = _creationRedemptions[account];
        uint256 oldDay = cr.day;
        if (oldDay < currentDay) {
            if (cr.creatingUnderlying > 0) {
                cr.createdShares = cr.createdShares.add(
                    cr.creatingUnderlying.multiplyDecimal(_historyCreationRate[oldDay])
                );
                cr.creatingUnderlying = 0;
            }
            if (cr.createdShares > 0) {
                uint256 conversionSize = fund.getConversionSize();
                if (conversionSize > cr.conversionIndex) {
                    (cr.createdShares, , ) = fund.batchConvert(
                        cr.createdShares,
                        0,
                        0,
                        cr.conversionIndex,
                        conversionSize
                    );
                    cr.conversionIndex = conversionSize;
                }
            }
            if (cr.redeemingShares > 0) {
                cr.redeemedUnderlying = cr.redeemedUnderlying.add(
                    cr.redeemingShares.multiplyDecimal(_historyRedemptionRate[oldDay])
                );
                cr.redeemingShares = 0;
            }
            cr.day = currentDay;
        }
    }

    function _updateCreationRedemption(address account, CreationRedemption memory cr) private {
        CreationRedemption storage old = _creationRedemptions[account];
        if (old.day != cr.day) {
            old.day = cr.day;
        }
        if (old.creatingUnderlying != cr.creatingUnderlying) {
            old.creatingUnderlying = cr.creatingUnderlying;
        }
        if (old.redeemingShares != cr.redeemingShares) {
            old.redeemingShares = cr.redeemingShares;
        }
        if (old.createdShares != cr.createdShares) {
            old.createdShares = cr.createdShares;
        }
        if (old.redeemedUnderlying != cr.redeemedUnderlying) {
            old.redeemedUnderlying = cr.redeemedUnderlying;
        }
        if (old.conversionIndex != cr.conversionIndex) {
            old.conversionIndex = cr.conversionIndex;
        }
    }

    modifier onlyActive() {
        // Check roles in Fund.
        require(fund.isPrimaryMarketActive(address(this), block.timestamp), "only when active");
        _;
    }

    modifier onlyFund() {
        require(msg.sender == address(fund), "only fund");
        _;
    }
}
