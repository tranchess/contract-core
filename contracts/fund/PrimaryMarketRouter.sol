// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../fund/ShareStaking.sol";

import "../interfaces/IPrimaryMarketRouter.sol";
import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/IStableSwap.sol";

contract PrimaryMarketRouter is IPrimaryMarketRouter, ITrancheIndexV2 {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    IPrimaryMarketV3 private immutable _pm;
    IFundV3 private immutable _fund;
    IERC20 private immutable _tokenUnderlying;
    address private immutable _tokenB;

    constructor(address pm) public {
        _pm = IPrimaryMarketV3(pm);
        _fund = IPrimaryMarketV3(pm).fund();
        _tokenUnderlying = IERC20(IPrimaryMarketV3(pm).fund().tokenUnderlying());
        _tokenB = IPrimaryMarketV3(pm).fund().tokenB();
    }

    /// @dev Get redemption with StableSwap getQuoteOut interface.
    function getQuoteOut(uint256 baseIn) external view override returns (uint256 quoteOut) {
        (quoteOut, ) = _pm.getRedemption(baseIn);
    }

    /// @dev Get creation for QUEEN with StableSwap getQuoteIn interface.
    function getQuoteIn(uint256 baseOut) external view override returns (uint256 quoteIn) {
        quoteIn = _pm.getCreationForQ(baseOut);
    }

    /// @dev Get creation with StableSwap getBaseOut interface.
    function getBaseOut(uint256 quoteIn) external view override returns (uint256 baseOut) {
        baseOut = _pm.getCreation(quoteIn);
    }

    /// @dev Get redemption for underlying with StableSwap getBaseIn interface.
    function getBaseIn(uint256 quoteOut) external view override returns (uint256 baseIn) {
        quoteOut = _pm.getRedemptionForUnderlying(baseIn);
    }

    /// @dev Create QUEEN with StableSwap buy interface.
    ///      Underlying should have already been sent to this contract
    function buy(
        uint256 version,
        uint256 baseOut,
        address recipient,
        bytes calldata data
    ) external override {
        (address primaryMarket, uint256 quoteIn) = abi.decode(data, (address, uint256));
        require(address(_pm) == primaryMarket); // sanity check

        IERC20(_tokenUnderlying).safeTransfer(address(_pm), quoteIn);
        uint256 outQ = _pm.create(recipient, 0, version);
        require(outQ == baseOut); // sanity check
    }

    /// @dev Redeem QUEEN with StableSwap sell interface.
    ///      QUEEN should have already been sent to this contract
    function sell(
        uint256 version,
        uint256 quoteOut,
        address recipient,
        bytes calldata data
    ) external override {
        (address primaryMarket, uint256 baseIn) = abi.decode(data, (address, uint256));
        require(address(_pm) == primaryMarket); // sanity check

        uint256 underlying = _pm.redeem(recipient, baseIn, 0, version);
        require(underlying == quoteOut); // sanity check
    }

    function create(
        uint256 underlying,
        address recipient,
        uint256 minOutQ,
        uint256 version
    ) public override returns (uint256 outQ) {
        IERC20(_tokenUnderlying).safeTransferFrom(msg.sender, address(_pm), underlying);
        outQ = _pm.create(recipient, minOutQ, version);
    }

    function createAndStake(
        uint256 underlying,
        uint256 minOutQ,
        address staking,
        uint256 version
    ) external override {
        // Create QUEEN
        uint256 outQ = create(underlying, address(this), minOutQ, version);
        // Stake QUEEN
        _fund.trancheTransfer(TRANCHE_Q, staking, outQ, version);
        ShareStaking(staking).deposit(TRANCHE_Q, outQ, msg.sender, version);
    }

    function createAndStake(
        address router,
        address quoteAddress,
        uint256 underlying,
        uint256 minOutQ,
        address staking,
        uint256 version
    ) external override {
        // Create QUEEN
        uint256 outQ = create(underlying, address(this), minOutQ, version);
        // Split QUEEN into BISHOP and ROOK
        uint256 outB = _pm.split(address(this), outQ, version);
        // Add BISHOP to stable swap
        {
            IStableSwap swap = ISwapRouter(router).getSwap(_tokenB, quoteAddress);
            _fund.trancheTransfer(TRANCHE_B, address(swap), outB, version);
            swap.addLiquidity(version, msg.sender);
        }
        // Stake rook
        _fund.trancheTransfer(TRANCHE_R, staking, outB, version);
        ShareStaking(staking).deposit(TRANCHE_R, outB, msg.sender, version);
    }
}
