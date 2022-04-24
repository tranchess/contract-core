// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/ISwapRouter.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../fund/ShareStaking.sol";

/// @title Tranchess Swap Router
/// @notice Router for stateless execution of swaps against Tranchess stable swaps
contract SwapRouter is ISwapRouter, ITrancheIndexV2, Ownable {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => IStableSwap)) private _swapMap;

    constructor() public {}

    /// @dev Returns the swap for the given token pair and fee. The swap contract may or may not exist.
    function getSwap(address baseToken, address quoteToken)
        public
        view
        override
        returns (IStableSwap)
    {
        (address token0, address token1) =
            baseToken < quoteToken ? (baseToken, quoteToken) : (quoteToken, baseToken);
        return _swapMap[token0][token1];
    }

    function addSwap(
        address baseToken,
        address quoteToken,
        address swap
    ) external onlyOwner {
        (address token0, address token1) =
            baseToken < quoteToken ? (baseToken, quoteToken) : (quoteToken, baseToken);
        _swapMap[token0][token1] = IStableSwap(swap);
    }

    function addLiquidity(
        address baseToken,
        address quoteToken,
        uint256 baseDelta,
        uint256 quoteDelta,
        uint256 minMintAmount,
        uint256 version,
        uint256 deadline
    ) external virtual override checkDeadline(deadline) {
        IStableSwap swap = getSwap(baseToken, quoteToken);
        IERC20(baseToken).safeTransferFrom(msg.sender, address(swap), baseDelta);
        IERC20(quoteToken).safeTransferFrom(msg.sender, address(swap), quoteDelta);
        uint256 mintAmount = swap.addLiquidity(version, msg.sender);
        require(mintAmount >= minMintAmount, "Insufficient output");
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        address staking,
        uint256[] calldata versions,
        uint256 deadline
    ) external virtual override checkDeadline(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(versions.length == path.length - 1, "Invalid version");
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "Insufficient output");
        IERC20(path[0]).safeTransferFrom(
            msg.sender,
            address(getSwap(path[0], path[1])),
            amounts[0]
        );
        if (staking == address(0)) {
            _swap(amounts, path, versions, to);
        } else {
            _swap(amounts, path, versions, address(this));
            ShareStaking(staking).deposit(
                TRANCHE_B,
                amounts[amounts.length - 1],
                to,
                versions[versions.length - 1]
            );
        }
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        address staking,
        uint256[] calldata versions,
        uint256 deadline
    ) external virtual override checkDeadline(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(versions.length == path.length - 1, "Invalid version");
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= amountInMax, "Excessive input");
        IERC20(path[0]).safeTransferFrom(
            msg.sender,
            address(getSwap(path[0], path[1])),
            amounts[0]
        );
        if (staking == address(0)) {
            _swap(amounts, path, versions, to);
        } else {
            _swap(amounts, path, versions, address(this));
            ShareStaking(staking).deposit(TRANCHE_B, amountOut, to, versions[versions.length - 1]);
        }
    }

    function getAmountsOut(uint256 amount, address[] memory path)
        public
        view
        override
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amount;
        for (uint256 i; i < path.length - 1; i++) {
            IStableSwap swap = getSwap(path[i], path[i + 1]);
            require(address(swap) != address(0));
            if (path[i] == swap.baseAddress()) {
                amounts[i + 1] = swap.getQuoteOut(amounts[i]);
            } else {
                amounts[i + 1] = swap.getBaseOut(amounts[i]);
            }
        }
    }

    function getAmountsIn(uint256 amount, address[] memory path)
        public
        view
        override
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amount;
        for (uint256 i = path.length - 1; i > 0; i--) {
            IStableSwap swap = getSwap(path[i - 1], path[i]);
            require(address(swap) != address(0));
            if (path[i] == swap.baseAddress()) {
                amounts[i - 1] = swap.getQuoteIn(amounts[i]);
            } else {
                amounts[i - 1] = swap.getBaseIn(amounts[i]);
            }
        }
    }

    function _swap(
        uint256[] memory amounts,
        address[] memory path,
        uint256[] calldata versions,
        address to
    ) internal virtual {
        for (uint256 i = 0; i < path.length - 1; i++) {
            IStableSwap swap = getSwap(path[i], path[i + 1]);
            address recipient =
                i < path.length - 2 ? address(getSwap(path[i + 1], path[i + 2])) : to;
            if (path[i] == swap.baseAddress()) {
                swap.sell(versions[i], amounts[i + 1], recipient, new bytes(0));
            } else {
                swap.buy(versions[i], amounts[i + 1], recipient, new bytes(0));
            }
        }
    }

    modifier checkDeadline(uint256 deadline) {
        require(block.timestamp <= deadline, "Transaction too old");
        _;
    }
}
