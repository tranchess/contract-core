// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./LiquidityGaugeConvex.sol";

interface IConvexPool {
    function coins(uint256 index) external view returns (address);

    function add_liquidity(
        uint256[2] memory amounts,
        uint256 min_mint_amount,
        bool use_eth,
        address receiver
    ) external payable returns (uint256);
}

interface IConvexLiquidityToken {
    function minter() external view returns (address);
}

contract ConvexRouter {
    using SafeERC20 for IERC20;

    LiquidityGaugeConvex public immutable tranchessLiquidityGauge;
    address public immutable wrappedToken;
    IERC20 public immutable ConvexLiquidityToken;
    IConvexPool public immutable ConvexPool;
    address[2] public coins;

    constructor(address tranchessLiquidityGauge_, address wrappedToken_) public {
        tranchessLiquidityGauge = LiquidityGaugeConvex(tranchessLiquidityGauge_);
        wrappedToken = wrappedToken_;

        IERC20 liquidityToken = LiquidityGaugeConvex(tranchessLiquidityGauge_).ConvexLiquidityToken();
        ConvexLiquidityToken = liquidityToken;
        IConvexPool pool = IConvexPool(IConvexLiquidityToken(address(liquidityToken)).minter());
        ConvexPool = pool;
        coins[0] = pool.coins(0);
        coins[1] = pool.coins(1);
    }

    receive() external payable {}

    function addLiquidity(
        uint256[2] memory amounts,
        uint256 minMintAmount,
        bool stakeFurther
    ) external payable returns (uint256 lpToken) {
        for (uint256 i = 0; i < coins.length; i++) {
            if (coins[i] != wrappedToken) {
                IERC20(coins[i]).safeTransferFrom(msg.sender, address(this), amounts[i]);
                IERC20(coins[i]).safeApprove(address(ConvexPool), amounts[i]);
            }
        }

        if (stakeFurther) {
            lpToken = ConvexPool.add_liquidity{value: msg.value}(
                amounts,
                minMintAmount,
                true,
                address(this)
            );
            ConvexLiquidityToken.safeApprove(address(tranchessLiquidityGauge), lpToken);
            tranchessLiquidityGauge.deposit(lpToken, msg.sender);
        } else {
            lpToken = ConvexPool.add_liquidity{value: msg.value}(
                amounts,
                minMintAmount,
                true,
                msg.sender
            );
        }
    }
}
