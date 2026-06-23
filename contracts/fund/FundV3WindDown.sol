// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../interfaces/IAprOracle.sol";
import "../interfaces/IBallot.sol";
import "../interfaces/IFundForPrimaryMarketV3.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/ITwapOracleV2.sol";
import "../interfaces/IWrappedERC20.sol";
import "../utils/CoreUtility.sol";

interface IFundV3WindDownAprOracle {
    // FundV3 has a public aprOracle variable, but IFundV3 does not include its getter.
    function aprOracle() external view returns (IAprOracle);
}

contract FundV3WindDown is
    ITwapOracleV2,
    IAprOracle,
    IBallot,
    IPrimaryMarketV3,
    ITrancheIndexV2,
    Ownable,
    ReentrancyGuard,
    CoreUtility
{
    using SafeMath for uint256;

    event Initialized(
        uint256 frozenPrice,
        uint256 frozenNavB,
        uint256 frozenNavR,
        uint256 frozenSplitRatio,
        uint256 totalUnderlying,
        uint256 totalSupplyQ,
        uint256 totalSupplyB,
        uint256 totalSupplyR
    );
    event Activated();
    event Deactivated();
    event RedeemedAll(
        address indexed account,
        address indexed recipient,
        uint256 inQ,
        uint256 inB,
        uint256 inR,
        uint256 underlying
    );

    uint256 public constant MAX_STRATEGY_UNDERLYING_DUST = 1;
    uint256 private constant UNIT = 1e18;

    address public immutable override fund;
    ITwapOracleV2 public immutable oldTwapOracle;
    IAprOracle public immutable oldAprOracle;
    uint256 public immutable freezeDay;

    bool public initialized;
    bool public active;

    uint256 public frozenPrice;
    uint256 public frozenNavB;
    uint256 public frozenNavR;
    uint256 public frozenSplitRatio;
    uint256 public initializedTotalUnderlying;
    uint256 public initializedTotalSupplyQ;
    uint256 public initializedTotalSupplyB;
    uint256 public initializedTotalSupplyR;

    uint256 private _underlyingPerQ;
    uint256 private _underlyingPerB;
    uint256 private _underlyingPerR;

    constructor(address fund_, uint256 freezeDay_) public Ownable() {
        require(fund_ != address(0), "Zero fund");
        require(freezeDay_ == _endOfDay(freezeDay_.sub(1)), "Invalid freeze day");
        require(freezeDay_ > block.timestamp, "Freeze day not future");

        // Capture the original oracles at deployment. This contract must be deployed
        // before the fund is updated to point at the wind-down contract.
        ITwapOracleV2 oldTwapOracle_ = IFundV3(fund_).twapOracle();
        IAprOracle oldAprOracle_ = IFundV3WindDownAprOracle(fund_).aprOracle();
        require(address(oldTwapOracle_) != address(0), "Zero TWAP oracle");
        require(address(oldAprOracle_) != address(0), "Zero APR oracle");

        fund = fund_;
        oldTwapOracle = oldTwapOracle_;
        oldAprOracle = oldAprOracle_;
        freezeDay = freezeDay_;
    }

    // ITwapOracle / ITwapOracleV2 implementation.

    function getTwap(uint256 timestamp) external view override returns (uint256) {
        if (timestamp > freezeDay) {
            // FundV3.settle() requires a nonzero TWAP. Returning zero after T
            // permanently blocks future settlements and rebalances.
            return 0;
        }
        return oldTwapOracle.getTwap(timestamp);
    }

    function getLatest() external view override returns (uint256) {
        if (block.timestamp < freezeDay) {
            return oldTwapOracle.getLatest();
        }
        if (initialized) {
            return frozenPrice;
        }
        // Before initialize(), swap pools can still sync after final settlement
        // using the frozen settlement TWAP instead of the live oracle price.
        uint256 price = oldTwapOracle.getTwap(freezeDay);
        require(price != 0, "Frozen price not ready");
        return price;
    }

    // IAprOracle implementation.

    function capture() external override returns (uint256 dailyRate) {
        // The old APR proxy performs the ShareStaking rebalance safety check.
        // Keep that side effect/check, then force the BISHOP rate to zero for
        // the frozen settlement day and later. Once T has arrived, use the fund
        // day so delayed pre-T settlements still receive the old APR.
        dailyRate = oldAprOracle.capture();
        if (block.timestamp >= freezeDay && IFundV3(fund).currentDay() >= freezeDay) {
            return 0;
        }
    }

    // IBallot implementation.

    function count(uint256) external view override returns (uint256) {
        return 0;
    }

    function syncWithVotingEscrow(address) external override {}

    // IPrimaryMarketV3 view implementation.

    function getCreation(uint256) external view override returns (uint256 outQ) {
        return 0;
    }

    function getCreationForQ(uint256) external view override returns (uint256) {
        revert("Wind down");
    }

    function getRedemption(uint256) external view override returns (uint256, uint256) {
        revert("Wind down");
    }

    function getRedemptionForUnderlying(uint256) external view override returns (uint256) {
        revert("Wind down");
    }

    function getSplit(uint256) external view override returns (uint256 outB) {
        return 0;
    }

    function getSplitForB(uint256) external view override returns (uint256 inQ) {
        return 0;
    }

    function getMerge(uint256) external view override returns (uint256 outQ, uint256 feeQ) {
        return (0, 0);
    }

    function getMergeForQ(uint256) external view override returns (uint256 inB) {
        return 0;
    }

    function canBeRemovedFromFund() external view override returns (bool) {
        return true;
    }

    // IPrimaryMarketV3 state-changing implementation. Legacy operations are
    // intentionally blocked; users exit through redeemAll() or redeemAllAndUnwrap().

    function create(address, uint256, uint256) external override returns (uint256) {
        revert("Wind down");
    }

    function redeem(address, uint256, uint256, uint256) external override returns (uint256) {
        revert("Wind down");
    }

    function redeemAndUnwrap(
        address,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256) {
        revert("Wind down");
    }

    function queueRedemption(
        address,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256, uint256) {
        revert("Wind down");
    }

    function claimRedemptions(address, uint256[] calldata) external override returns (uint256) {
        revert("Wind down");
    }

    function claimRedemptionsAndUnwrap(
        address,
        uint256[] calldata
    ) external override returns (uint256) {
        revert("Wind down");
    }

    function split(address, uint256, uint256) external override returns (uint256) {
        revert("Wind down");
    }

    function merge(address, uint256, uint256) external override returns (uint256) {
        revert("Wind down");
    }

    function settle(uint256) external override {}

    // Wind-down owner controls.

    function initialize() external onlyOwner {
        require(!initialized, "Already initialized");

        IFundV3 fundContract = IFundV3(fund);
        _checkFundReady(fundContract);
        require(fundContract.currentDay() > freezeDay, "Final settlement not done");

        uint256 price = oldTwapOracle.getTwap(freezeDay);
        require(price != 0, "Frozen price not ready");

        // Use the actual hot token balance, not getTotalUnderlying(), because
        // getTotalUnderlying() includes stale strategy-accounting dust.
        (uint256 navB, uint256 navR) = fundContract.historicalNavs(freezeDay);
        uint256 navSum = navB.add(navR);
        uint256 splitRatio = fundContract.splitRatio();
        uint256 totalUnderlying = IERC20(fundContract.tokenUnderlying()).balanceOf(fund);
        uint256 totalSupplyQ = fundContract.trancheTotalSupply(TRANCHE_Q);
        uint256 totalSupplyB = fundContract.trancheTotalSupply(TRANCHE_B);
        uint256 totalSupplyR = fundContract.trancheTotalSupply(TRANCHE_R);

        uint256 valuePerQ = splitRatio.mul(navSum).div(UNIT);
        uint256 totalValueShares = totalSupplyQ.mul(valuePerQ).add(totalSupplyB.mul(navB)).add(
            totalSupplyR.mul(navR)
        );
        require(totalUnderlying > 0, "No underlying");
        require(totalValueShares > 0, "No share value");

        // Fixed per-token rates make redemption order irrelevant; after B/R
        // burns, FundV3's equivalent-total supply formulas become unreliable.
        frozenPrice = price;
        frozenNavB = navB;
        frozenNavR = navR;
        frozenSplitRatio = splitRatio;
        initializedTotalUnderlying = totalUnderlying;
        initializedTotalSupplyQ = totalSupplyQ;
        initializedTotalSupplyB = totalSupplyB;
        initializedTotalSupplyR = totalSupplyR;
        _underlyingPerQ = totalUnderlying.mul(valuePerQ).mul(UNIT).div(totalValueShares);
        _underlyingPerB = totalUnderlying.mul(navB).mul(UNIT).div(totalValueShares);
        _underlyingPerR = totalUnderlying.mul(navR).mul(UNIT).div(totalValueShares);
        initialized = true;

        emit Initialized(
            price,
            navB,
            navR,
            splitRatio,
            totalUnderlying,
            totalSupplyQ,
            totalSupplyB,
            totalSupplyR
        );
    }

    function activate() external onlyOwner {
        require(initialized, "Not initialized");
        require(!active, "Already active");

        IFundV3 fundContract = IFundV3(fund);
        _checkFundReady(fundContract);
        require(
            IERC20(fundContract.tokenUnderlying()).balanceOf(fund) >=
                _getTotalRedeemableUnderlying(fundContract),
            "Insufficient underlying"
        );

        active = true;
        emit Activated();
    }

    function deactivate() external onlyOwner {
        require(active, "Not active");
        active = false;
        emit Deactivated();
    }

    // Wind-down redemption views.

    function underlyingPerQ() external view returns (uint256) {
        _requireInitialized();
        return _underlyingPerQ;
    }

    function underlyingPerB() external view returns (uint256) {
        _requireInitialized();
        return _underlyingPerB;
    }

    function underlyingPerR() external view returns (uint256) {
        _requireInitialized();
        return _underlyingPerR;
    }

    function getRedeemAll(address account) public view returns (uint256 underlying) {
        _requireInitialized();
        (uint256 inQ, uint256 inB, uint256 inR) = IFundV3(fund).trancheAllBalanceOf(account);
        return _getUnderlying(inQ, inB, inR);
    }

    // Wind-down redemption entrypoint.

    function redeemAll(
        address recipient,
        uint256 minUnderlying
    ) external nonReentrant returns (uint256 underlying) {
        (uint256 inQ, uint256 inB, uint256 inR, uint256 underlying_) = _burnRedeemAll(
            minUnderlying
        );
        underlying = underlying_;

        IFundForPrimaryMarketV3(fund).primaryMarketTransferUnderlying(recipient, underlying, 0);

        emit RedeemedAll(msg.sender, recipient, inQ, inB, inR, underlying);
    }

    function redeemAllAndUnwrap(
        address recipient,
        uint256 minUnderlying
    ) external nonReentrant returns (uint256 underlying) {
        (uint256 inQ, uint256 inB, uint256 inR, uint256 underlying_) = _burnRedeemAll(
            minUnderlying
        );
        underlying = underlying_;

        IFundForPrimaryMarketV3(fund).primaryMarketTransferUnderlying(address(this), underlying, 0);
        IWrappedERC20(IFundV3(fund).tokenUnderlying()).withdraw(underlying);
        (bool success, ) = recipient.call{value: underlying}("");
        require(success, "Transfer failed");

        emit RedeemedAll(msg.sender, recipient, inQ, inB, inR, underlying);
    }

    // Internal helpers.

    function _burnRedeemAll(
        uint256 minUnderlying
    ) private returns (uint256 inQ, uint256 inB, uint256 inR, uint256 underlying) {
        require(active, "Not active");

        IFundV3 fundContract = IFundV3(fund);
        uint256 version = fundContract.getRebalanceSize();
        (inQ, inB, inR) = fundContract.trancheAllBalanceOf(msg.sender);
        underlying = _getUnderlying(inQ, inB, inR);
        require(underlying >= minUnderlying && underlying > 0, "Min underlying redeemed");

        IFundForPrimaryMarketV3 fundForPrimaryMarket = IFundForPrimaryMarketV3(fund);
        if (inQ > 0) {
            fundForPrimaryMarket.primaryMarketBurn(TRANCHE_Q, msg.sender, inQ, version);
        }
        if (inB > 0) {
            fundForPrimaryMarket.primaryMarketBurn(TRANCHE_B, msg.sender, inB, version);
        }
        if (inR > 0) {
            fundForPrimaryMarket.primaryMarketBurn(TRANCHE_R, msg.sender, inR, version);
        }
    }

    function _checkFundReady(IFundV3 fundContract) private view {
        require(fundContract.primaryMarket() == address(this), "Not primary market");
        require(fundContract.strategy() == address(0), "Strategy not cleared");
        require(
            fundContract.getStrategyUnderlying() <= MAX_STRATEGY_UNDERLYING_DUST,
            "Strategy underlying not cleared"
        );
        require(fundContract.getTotalDebt() == 0, "Debt not cleared");
    }

    function _getUnderlying(uint256 inQ, uint256 inB, uint256 inR) private view returns (uint256) {
        return
            inQ.mul(_underlyingPerQ).div(UNIT).add(inB.mul(_underlyingPerB).div(UNIT)).add(
                inR.mul(_underlyingPerR).div(UNIT)
            );
    }

    function _getTotalRedeemableUnderlying(IFundV3 fundContract) private view returns (uint256) {
        return
            _getUnderlying(
                fundContract.trancheTotalSupply(TRANCHE_Q),
                fundContract.trancheTotalSupply(TRANCHE_B),
                fundContract.trancheTotalSupply(TRANCHE_R)
            );
    }

    function _requireInitialized() private view {
        require(initialized, "Not initialized");
    }

    function _endOfDay(uint256 timestamp) private pure returns (uint256) {
        return ((timestamp.add(1 days) - SETTLEMENT_TIME) / 1 days) * 1 days + SETTLEMENT_TIME;
    }

    receive() external payable {}
}
