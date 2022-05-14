// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../fund/ShareStaking.sol";

import "../interfaces/IPrimaryMarketRouter.sol";
import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/IStableSwap.sol";
import "../interfaces/IWrappedERC20.sol";

contract PrimaryMarketRouter is IPrimaryMarketRouter, ITrancheIndexV2 {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    IPrimaryMarketV3 public immutable primaryMarket;
    IFundV3 public immutable fund;
    IERC20 private immutable _tokenUnderlying;
    address private immutable _tokenB;

    constructor(address pm) public {
        primaryMarket = IPrimaryMarketV3(pm);
        IFundV3 fund_ = IPrimaryMarketV3(pm).fund();
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

    function createAndStake(
        uint256 underlying,
        uint256 minOutQ,
        address staking,
        uint256 version
    ) external payable override {
        // Create QUEEN
        uint256 outQ = create(staking, underlying, minOutQ, version);
        // Stake QUEEN
        ShareStaking(staking).deposit(TRANCHE_Q, outQ, msg.sender, version);
    }

    function createSplitAndStake(
        address router,
        address quoteAddress,
        uint256 underlying,
        uint256 minOutQ,
        address staking,
        uint256 version
    ) external payable override {
        // Create QUEEN
        uint256 outQ = create(address(this), underlying, minOutQ, version);
        _splitAndStake(router, quoteAddress, outQ, staking, version);
    }

    function splitAndStake(
        address router,
        address quoteAddress,
        uint256 inQ,
        address staking,
        uint256 version
    ) external override {
        primaryMarket.fund().trancheTransferFrom(
            TRANCHE_Q,
            msg.sender,
            address(this),
            inQ,
            version
        );
        _splitAndStake(router, quoteAddress, inQ, staking, version);
    }

    function _splitAndStake(
        address router,
        address quoteAddress,
        uint256 inQ,
        address staking,
        uint256 version
    ) private {
        // Split QUEEN into BISHOP and ROOK
        uint256 outB = primaryMarket.split(address(this), inQ, version);
        // Add BISHOP to stable swap
        {
            IStableSwap swap = ISwapRouter(router).getSwap(_tokenB, quoteAddress);
            fund.trancheTransfer(TRANCHE_B, address(swap), outB, version);
            swap.addLiquidity(version, msg.sender);
        }

        if (staking == address(0)) {
            fund.trancheTransfer(TRANCHE_R, msg.sender, outB, version);
        } else {
            // Stake rook
            fund.trancheTransfer(TRANCHE_R, staking, outB, version);
            ShareStaking(staking).deposit(TRANCHE_R, outB, msg.sender, version);
        }
    }
}
