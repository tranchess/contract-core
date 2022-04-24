// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../interfaces/ISwapRouter.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/IPrimaryMarketV3.sol";
import "../interfaces/IWrappedERC20.sol";

/// @title Tranchess Queen Swap Router
/// @notice Router for stateless execution of Queen exchange
contract QueenSwapRouter is ITrancheIndexV2, IPrimaryMarketV3 {
    using SafeERC20 for IERC20;

    ISwapRouter public immutable swapRouter;
    IFundV3 public immutable override fund;
    address private immutable _tokenUnderlying;
    address private immutable _tokenQ;

    constructor(address swapRouter_, address fund_) public {
        swapRouter = ISwapRouter(swapRouter_);
        fund = IFundV3(fund_);
        _tokenUnderlying = IFundV3(fund_).tokenUnderlying();
        _tokenQ = IFundV3(fund_).tokenQ();
    }

    /// @notice Receive unwrapped transfer from the wrapped token.
    receive() external payable {}

    function create(
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) external override returns (uint256 outQ) {
        IERC20(_tokenUnderlying).safeTransferFrom(msg.sender, address(this), underlying);
        outQ = _create(fund.primaryMarket(), recipient, underlying, minOutQ, version);
    }

    function wrapAndCreate(
        address recipient,
        uint256 minOutQ,
        uint256 version
    ) external payable override returns (uint256 outQ) {
        IWrappedERC20(_tokenUnderlying).deposit{value: msg.value}();
        outQ = _create(fund.primaryMarket(), recipient, msg.value, minOutQ, version);
    }

    /// @dev Unlike normal redeem, a user could send QUEEN before calling this redeem().
    ///      The contract first measures how much it has received, then ask to transfer
    ///      the rest from the user.
    function redeem(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external override returns (uint256 underlying) {
        // QUEEN balance of this contract is preferred
        uint256 balanceQ = IERC20(_tokenQ).balanceOf(address(this));
        if (balanceQ < inQ) {
            // Retain the rest of QUEEN
            fund.trancheTransferFrom(TRANCHE_Q, msg.sender, address(this), inQ - balanceQ, version);
        }
        underlying = _redeem(fund.primaryMarket(), recipient, inQ, minUnderlying, version);
    }

    function redeemAndUnwrap(
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) external override returns (uint256 underlying) {
        fund.trancheTransferFrom(TRANCHE_Q, msg.sender, address(this), inQ, version);
        underlying = _redeem(fund.primaryMarket(), address(this), inQ, minUnderlying, version);
        IWrappedERC20(_tokenUnderlying).withdraw(underlying);
        (bool success, ) = recipient.call{value: underlying}("");
        require(success, "Transfer failed");
    }

    function _create(
        address primaryMarket,
        address recipient,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) private returns (uint256 outQ) {
        IPrimaryMarketV3 pm = IPrimaryMarketV3(primaryMarket);
        // Get out amount from swap
        address[] memory path = new address[](2);
        path[0] = _tokenUnderlying;
        path[1] = _tokenQ;
        uint256 swapAmount = swapRouter.getAmountsOut(underlying, path)[1];
        // Get out amount from primary market
        uint256 pmAmount = pm.getCreation(underlying);

        if (pmAmount < swapAmount) {
            // Swap path
            IERC20(path[0]).safeApprove(address(swapRouter), underlying);
            uint256[] memory versions = new uint256[](1);
            versions[0] = version;
            outQ = swapRouter.swapExactTokensForTokens(
                underlying,
                minOutQ,
                path,
                recipient,
                address(0),
                versions,
                block.timestamp
            )[1];
        } else {
            // Primary market path
            IERC20(path[0]).safeApprove(address(pm), underlying);
            outQ = pm.create(recipient, underlying, minOutQ, version);
        }
    }

    function _redeem(
        address primaryMarket,
        address recipient,
        uint256 inQ,
        uint256 minUnderlying,
        uint256 version
    ) private returns (uint256 underlying) {
        IPrimaryMarketV3 pm = IPrimaryMarketV3(primaryMarket);
        // Get out amount from swap
        address[] memory path = new address[](2);
        path[0] = _tokenQ;
        path[1] = _tokenUnderlying;
        uint256 swapAmount = swapRouter.getAmountsOut(inQ, path)[1];
        // Get out amount from primary market
        (uint256 pmAmount, ) = pm.getRedemption(inQ);

        if (pmAmount < swapAmount) {
            // Swap path
            pm.fund().trancheApprove(TRANCHE_Q, address(swapRouter), inQ, version);
            uint256[] memory versions = new uint256[](1);
            versions[0] = version;
            underlying = swapRouter.swapExactTokensForTokens(
                inQ,
                minUnderlying,
                path,
                recipient,
                address(0),
                versions,
                block.timestamp
            )[1];
        } else {
            // Primary market path
            underlying = pm.redeem(recipient, inQ, minUnderlying, version);
        }
    }

    // ------------------------ Unsupported Functions --------------------------
    function getCreationForQ(uint256) external view override returns (uint256) {
        revert("Not Supported");
    }

    function getSplitForB(uint256) external view override returns (uint256) {
        revert("Not Supported");
    }

    function getCreation(uint256) external view override returns (uint256) {
        revert("Not Supported");
    }

    function getRedemption(uint256) external view override returns (uint256, uint256) {
        revert("Not Supported");
    }

    function getRedemptionForUnderlying(uint256) external view override returns (uint256) {
        revert("Not Supported");
    }

    function getSplit(uint256) external view override returns (uint256) {
        revert("Not Supported");
    }

    function getMerge(uint256) external view override returns (uint256, uint256) {
        revert("Not Supported");
    }

    function getMergeForQ(uint256) external view override returns (uint256) {
        revert("Not Supported");
    }

    function canBeRemovedFromFund() external view override returns (bool) {
        revert("Not Supported");
    }

    function split(
        address,
        uint256,
        uint256
    ) external override returns (uint256) {
        revert("Not Supported");
    }

    function merge(
        address,
        uint256,
        uint256
    ) external override returns (uint256) {
        revert("Not Supported");
    }

    function queueRedemption(
        address,
        uint256,
        uint256,
        uint256
    ) external override returns (uint256, uint256) {
        revert("Not Supported");
    }

    function claimRedemptions(address, uint256[] calldata) external override returns (uint256) {
        revert("Not Supported");
    }

    function claimRedemptionsAndUnwrap(address, uint256[] calldata)
        external
        override
        returns (uint256)
    {
        revert("Not Supported");
    }

    function settle(uint256) external override {
        revert("Not Supported");
    }
}
