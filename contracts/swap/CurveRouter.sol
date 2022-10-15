// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./LiquidityGaugeCurve.sol";

interface ICurvePool {
    function WETH20() external view returns (address);

    function coins(uint256 index) external view returns (address);

    function add_liquidity(
        uint256[2] memory amounts,
        uint256 min_mint_amount,
        bool use_eth,
        address receiver
    ) external payable returns (uint256);
}

contract CurveRouter {
    using SafeERC20 for IERC20;

    ICurvePool public immutable curvePool;
    address public immutable WETH20;
    LiquidityGaugeCurve public immutable tranchessLiquidityGauge;
    IERC20 public immutable curveLiquidityToken;
    address[2] public coins;

    constructor(address curvePool_, address tranchessLiquidityGauge_) public {
        curvePool = ICurvePool(curvePool_);
        WETH20 = ICurvePool(curvePool_).WETH20();
        coins[0] = ICurvePool(curvePool_).coins(0);
        coins[1] = ICurvePool(curvePool_).coins(1);

        tranchessLiquidityGauge = LiquidityGaugeCurve(tranchessLiquidityGauge_);
        curveLiquidityToken = LiquidityGaugeCurve(tranchessLiquidityGauge_).curveLiquidityToken();
    }

    receive() external payable {}

    function addLiquidity(
        uint256[2] memory amounts,
        uint256 minMintAmount,
        bool stakeFurther
    ) external payable returns (uint256 lpToken) {
        for (uint256 i = 0; i < coins.length; i++) {
            if (coins[i] != WETH20) {
                IERC20(coins[i]).safeTransferFrom(msg.sender, address(this), amounts[i]);
                IERC20(coins[i]).safeApprove(address(curvePool), amounts[i]);
            }
        }

        if (stakeFurther) {
            lpToken = curvePool.add_liquidity{value: msg.value}(
                amounts,
                minMintAmount,
                true,
                address(this)
            );
            curveLiquidityToken.safeApprove(address(tranchessLiquidityGauge), lpToken);
            tranchessLiquidityGauge.deposit(lpToken, msg.sender);
        } else {
            lpToken = curvePool.add_liquidity{value: msg.value}(
                amounts,
                minMintAmount,
                true,
                msg.sender
            );
        }
    }
}
