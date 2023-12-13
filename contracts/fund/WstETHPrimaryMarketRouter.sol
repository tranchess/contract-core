// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../interfaces/IWstETHPrimaryMarketRouter.sol";
import "../interfaces/IPrimaryMarketV5.sol";
import "../interfaces/IWstETH.sol";
import "../interfaces/ITrancheIndexV2.sol";

contract WstETHPrimaryMarketRouter is IWstETHPrimaryMarketRouter, ITrancheIndexV2 {
    using SafeERC20 for IERC20;

    IPrimaryMarketV5 public immutable primaryMarket;
    IFundV3 public immutable fund;
    address private immutable _wstETH;
    address private immutable _stETH;
    address private immutable _tokenB;

    constructor(address pm) public {
        primaryMarket = IPrimaryMarketV5(pm);
        IFundV3 fund_ = IFundV3(IPrimaryMarketV5(pm).fund());
        fund = fund_;
        _wstETH = fund_.tokenUnderlying();
        _stETH = IWstETH(fund_.tokenUnderlying()).stETH();
        _tokenB = fund_.tokenB();
    }

    /// @dev Get redemption with StableSwap getQuoteOut interface.
    function getQuoteOut(uint256 baseIn) external view override returns (uint256 quoteOut) {
        (quoteOut, ) = primaryMarket.getRedemption(baseIn);
    }

    /// @dev Get creation for QUEEN with StableSwap getQuoteIn interface.
    function getQuoteIn(uint256 baseOut) external view override returns (uint256 quoteIn) {
        quoteIn = primaryMarket.getCreationForQ(baseOut);
    }

    /// @dev Get creation with StableSwap getBaseOut interface.
    function getBaseOut(uint256 quoteIn) external view override returns (uint256 baseOut) {
        baseOut = primaryMarket.getCreation(quoteIn);
    }

    /// @dev Get redemption for underlying with StableSwap getBaseIn interface.
    function getBaseIn(uint256 quoteOut) external view override returns (uint256 baseIn) {
        baseIn = primaryMarket.getRedemptionForUnderlying(quoteOut);
    }

    /// @dev Create QUEEN with StableSwap buy interface.
    ///      Underlying should have already been sent to this contract
    function buy(
        uint256 version,
        uint256 baseOut,
        address recipient,
        bytes calldata
    ) external override returns (uint256 realBaseOut) {
        uint256 routerQuoteBalance = IERC20(_wstETH).balanceOf(address(this));
        IERC20(_wstETH).safeTransfer(address(primaryMarket), routerQuoteBalance);
        realBaseOut = primaryMarket.create(recipient, baseOut, version);
    }

    /// @dev Redeem QUEEN with StableSwap sell interface.
    ///      QUEEN should have already been sent to this contract
    function sell(
        uint256 version,
        uint256 quoteOut,
        address recipient,
        bytes calldata
    ) external override returns (uint256 realQuoteOut) {
        uint256 routerBaseBalance = fund.trancheBalanceOf(TRANCHE_Q, address(this));
        realQuoteOut = primaryMarket.redeem(recipient, routerBaseBalance, quoteOut, version);
    }

    function create(
        address recipient,
        bool isWrapped,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) public override returns (uint256 outQ) {
        if (isWrapped) {
            IERC20(_stETH).safeTransferFrom(msg.sender, address(this), underlying);
            underlying = IWstETH(_wstETH).wrap(underlying);
            IERC20(_wstETH).safeTransfer(address(primaryMarket), underlying);
        } else {
            IERC20(_wstETH).safeTransferFrom(msg.sender, address(primaryMarket), underlying);
        }

        outQ = primaryMarket.create(recipient, minOutQ, version);
    }

    function createAndSplit(
        uint256 underlying,
        bool isWrapped,
        uint256 minOutQ,
        uint256 version
    ) external override {
        // Create QUEEN
        uint256 outQ = create(address(this), isWrapped, underlying, minOutQ, version);

        // Split QUEEN into BISHOP and ROOK
        (uint256 outB, uint256 outR) = primaryMarket.split(address(this), outQ, version);

        fund.trancheTransfer(TRANCHE_B, msg.sender, outB, version);
        fund.trancheTransfer(TRANCHE_R, msg.sender, outR, version);
    }
}
