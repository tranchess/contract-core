// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../fund/ShareStaking.sol";

import "../interfaces/IPrimaryMarketRouterV2.sol";
import "../interfaces/IPrimaryMarketV5.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/IStableSwap.sol";
import "../interfaces/IWrappedERC20.sol";

contract PrimaryMarketRouterV2 is IPrimaryMarketRouterV2, ITrancheIndexV2 {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    IPrimaryMarketV5 public immutable primaryMarket;
    IFundV3 public immutable fund;
    IERC20 private immutable _tokenUnderlying;
    address private immutable _tokenB;

    constructor(address pm) public {
        primaryMarket = IPrimaryMarketV5(pm);
        IFundV3 fund_ = IFundV3(IPrimaryMarketV5(pm).fund());
        fund = fund_;
        _tokenUnderlying = IERC20(fund_.tokenUnderlying());
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
        uint256 routerQuoteBalance = IERC20(_tokenUnderlying).balanceOf(address(this));
        IERC20(_tokenUnderlying).safeTransfer(address(primaryMarket), routerQuoteBalance);
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
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) public payable override returns (uint256 outQ) {
        if (msg.value > 0) {
            require(msg.value == underlying); // sanity check
            IWrappedERC20(address(_tokenUnderlying)).deposit{value: msg.value}();
            _tokenUnderlying.safeTransfer(address(primaryMarket), msg.value);
        } else {
            IERC20(_tokenUnderlying).safeTransferFrom(
                msg.sender,
                address(primaryMarket),
                underlying
            );
        }

        outQ = primaryMarket.create(recipient, minOutQ, version);
    }

    function createAndSplit(
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) external payable override returns (uint256 outB, uint256 outR) {
        uint256 outQ = create(address(this), underlying, minOutQ, version);
        (outB, outR) = primaryMarket.split(recipient, outQ, version);
    }
}
