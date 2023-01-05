// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../interfaces/IStableSwap.sol";
import "../interfaces/ITrancheIndexV2.sol";

/// @dev See IVault.sol under https://github.com/balancer-labs/balancer-v2-monorepo/
interface IBalancerVault {
    enum SwapKind {GIVEN_IN, GIVEN_OUT}

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address recipient;
        bool toInternalBalance;
    }

    struct BatchSwapStep {
        bytes32 poolId;
        uint256 assetInIndex;
        uint256 assetOutIndex;
        uint256 amount;
        bytes userData;
    }

    function WETH() external view returns (address);

    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256);

    function queryBatchSwap(
        SwapKind kind,
        BatchSwapStep[] memory swaps,
        address[] memory assets,
        FundManagement memory funds
    ) external returns (int256[] memory assetDeltas);
}

contract BalancerV2Router is IStableSwapCoreInternalRevertExpected, ITrancheIndexV2 {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    IFundV3 public immutable fund;
    address private immutable _tokenUnderlying;
    address private immutable _tokenQ;
    IBalancerVault public immutable vault;
    bytes32 public immutable poolId;

    constructor(
        address fund_,
        address vault_,
        bytes32 poolId_
    ) public {
        fund = IFundV3(fund_);
        _tokenUnderlying = IFundV3(fund_).tokenUnderlying();
        _tokenQ = IFundV3(fund_).tokenQ();
        vault = IBalancerVault(vault_);
        poolId = poolId_;
    }

    /// @dev Get redemption with StableSwap getQuoteOut interface.
    function getQuoteOut(uint256 baseIn) external override returns (uint256 quoteOut) {
        quoteOut = querySwap(
            IBalancerVault.SingleSwap({
                poolId: poolId,
                kind: IBalancerVault.SwapKind.GIVEN_IN,
                assetIn: _tokenQ,
                assetOut: _tokenUnderlying,
                amount: baseIn,
                userData: ""
            })
        );
    }

    /// @dev Get creation for QUEEN with StableSwap getQuoteIn interface.
    function getQuoteIn(uint256 baseOut) external override returns (uint256 quoteIn) {
        quoteIn = querySwap(
            IBalancerVault.SingleSwap({
                poolId: poolId,
                kind: IBalancerVault.SwapKind.GIVEN_OUT,
                assetIn: _tokenUnderlying,
                assetOut: _tokenQ,
                amount: baseOut,
                userData: ""
            })
        );
    }

    /// @dev Get creation with StableSwap getBaseOut interface.
    function getBaseOut(uint256 quoteIn) external override returns (uint256 baseOut) {
        baseOut = querySwap(
            IBalancerVault.SingleSwap({
                poolId: poolId,
                kind: IBalancerVault.SwapKind.GIVEN_IN,
                assetIn: _tokenUnderlying,
                assetOut: _tokenQ,
                amount: quoteIn,
                userData: ""
            })
        );
    }

    /// @dev Get redemption for underlying with StableSwap getBaseIn interface.
    function getBaseIn(uint256 quoteOut) external override returns (uint256 baseIn) {
        baseIn = querySwap(
            IBalancerVault.SingleSwap({
                poolId: poolId,
                kind: IBalancerVault.SwapKind.GIVEN_OUT,
                assetIn: _tokenQ,
                assetOut: _tokenUnderlying,
                amount: quoteOut,
                userData: ""
            })
        );
    }

    /// @dev Create QUEEN with StableSwap buy interface.
    ///      Underlying should have already been sent to this contract
    function buy(
        uint256,
        uint256 baseOut,
        address recipient,
        bytes calldata
    ) external override returns (uint256 realBaseOut) {
        uint256 routerQuoteBalance = IERC20(_tokenUnderlying).balanceOf(address(this));
        IERC20(_tokenUnderlying).safeApprove(address(vault), routerQuoteBalance);

        IBalancerVault.SingleSwap memory singleSwap =
            IBalancerVault.SingleSwap({
                poolId: poolId,
                kind: IBalancerVault.SwapKind.GIVEN_IN,
                assetIn: _tokenUnderlying,
                assetOut: _tokenQ,
                amount: routerQuoteBalance,
                userData: ""
            });
        IBalancerVault.FundManagement memory funds =
            IBalancerVault.FundManagement({
                sender: address(this),
                fromInternalBalance: false,
                recipient: recipient,
                toInternalBalance: false
            });

        realBaseOut = vault.swap(singleSwap, funds, baseOut, block.timestamp);
    }

    /// @dev Redeem QUEEN with StableSwap sell interface.
    ///      QUEEN should have already been sent to this contract
    function sell(
        uint256,
        uint256 quoteOut,
        address recipient,
        bytes calldata
    ) external override returns (uint256 realQuoteOut) {
        uint256 routerBaseBalance = fund.trancheBalanceOf(TRANCHE_Q, address(this));
        fund.trancheApprove(TRANCHE_Q, address(vault), routerBaseBalance, fund.getRebalanceSize());

        IBalancerVault.SingleSwap memory singleSwap =
            IBalancerVault.SingleSwap({
                poolId: poolId,
                kind: IBalancerVault.SwapKind.GIVEN_IN,
                assetIn: _tokenQ,
                assetOut: _tokenUnderlying,
                amount: routerBaseBalance,
                userData: ""
            });
        IBalancerVault.FundManagement memory funds =
            IBalancerVault.FundManagement({
                sender: address(this),
                fromInternalBalance: false,
                recipient: recipient,
                toInternalBalance: false
            });

        realQuoteOut = vault.swap(singleSwap, funds, quoteOut, block.timestamp);
    }

    /// @dev See BalancerQueries.sol under https://github.com/balancer-labs/balancer-v2-monorepo/
    function querySwap(IBalancerVault.SingleSwap memory singleSwap) public returns (uint256) {
        // The Vault only supports batch swap queries, so we need to convert the swap call into an equivalent batch
        // swap. The result will be identical.

        // The main difference between swaps and batch swaps is that batch swaps require an assets array. We're going
        // to place the asset in at index 0, and asset out at index 1.
        address[] memory assets = new address[](2);
        assets[0] = singleSwap.assetIn;
        assets[1] = singleSwap.assetOut;

        IBalancerVault.BatchSwapStep[] memory swaps = new IBalancerVault.BatchSwapStep[](1);
        swaps[0] = IBalancerVault.BatchSwapStep({
            poolId: singleSwap.poolId,
            assetInIndex: 0,
            assetOutIndex: 1,
            amount: singleSwap.amount,
            userData: singleSwap.userData
        });

        IBalancerVault.FundManagement memory funds =
            IBalancerVault.FundManagement({
                sender: address(0),
                fromInternalBalance: false,
                recipient: address(0),
                toInternalBalance: false
            });

        int256[] memory assetDeltas = queryBatchSwap(singleSwap.kind, swaps, assets, funds);

        // Batch swaps return the full Vault asset deltas, which in the special case of a single step swap contains more
        // information than we need (as the amount in is known in a GIVEN_IN swap, and the amount out is known in a
        // GIVEN_OUT swap). We extract the information we're interested in.
        if (singleSwap.kind == IBalancerVault.SwapKind.GIVEN_IN) {
            // The asset out will have a negative Vault delta (the assets are coming out of the Pool and the user is
            // receiving them), so make it positive to match the `swap` interface.

            require(assetDeltas[1] <= 0, "SHOULD_NOT_HAPPEN");
            return uint256(-assetDeltas[1]);
        } else {
            // The asset in will have a positive Vault delta (the assets are going into the Pool and the user is
            // sending them), so we don't need to do anything.
            return uint256(assetDeltas[0]);
        }
    }

    function queryBatchSwap(
        IBalancerVault.SwapKind kind,
        IBalancerVault.BatchSwapStep[] memory swaps,
        address[] memory assets,
        IBalancerVault.FundManagement memory funds
    ) public returns (int256[] memory assetDeltas) {
        (, bytes memory returnData) =
            address(vault).call(
                abi.encodeWithSelector(
                    IBalancerVault.queryBatchSwap.selector,
                    kind,
                    swaps,
                    assets,
                    funds
                )
            );
        assetDeltas = abi.decode(returnData, (int256[]));
        require(assetDeltas.length == swaps.length.add(1), "Unexpected length");
    }
}
