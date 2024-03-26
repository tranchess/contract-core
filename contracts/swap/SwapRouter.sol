// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/ISwapRouter.sol";
import "../interfaces/ITrancheIndexV2.sol";
import "../fund/ShareStaking.sol";
import "../interfaces/IWrappedERC20.sol";
import "../interfaces/IWstETH.sol";

/// @title Tranchess Swap Router
/// @notice Router for stateless execution of swaps against Tranchess stable swaps
contract SwapRouter is ISwapRouter, ITrancheIndexV2, Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    address public immutable wstETH;
    address public immutable stETH;

    constructor(address wstETH_) public {
        wstETH = wstETH_;
        stETH = wstETH_ == address(0) ? address(0) : IWstETH(wstETH_).stETH();
    }

    event SwapAdded(address addr0, address addr1, address swap);

    mapping(address => mapping(address => IStableSwap)) private _swapMap;

    /// @dev Returns the swap for the given token pair and fee. The swap contract may or may not exist.
    function getSwap(
        address baseAddress,
        address quoteAddress
    ) public view override returns (IStableSwap) {
        (address addr0, address addr1) = baseAddress < quoteAddress
            ? (baseAddress, quoteAddress)
            : (quoteAddress, baseAddress);
        return _swapMap[addr0][addr1];
    }

    function addSwap(address baseAddress, address quoteAddress, address swap) external onlyOwner {
        require(
            swap == address(0) ||
                (baseAddress == IStableSwap(swap).baseAddress() &&
                    quoteAddress == IStableSwap(swap).quoteAddress())
        ); // sanity check
        (address addr0, address addr1) = baseAddress < quoteAddress
            ? (baseAddress, quoteAddress)
            : (quoteAddress, baseAddress);
        _swapMap[addr0][addr1] = IStableSwap(swap);
        emit SwapAdded(addr0, addr1, swap);
    }

    receive() external payable {}

    function addLiquidity(
        address baseAddress,
        address quoteAddress,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 minLpOut,
        uint256 version,
        uint256 deadline
    ) external payable override checkDeadline(deadline) {
        IStableSwap swap = getSwap(baseAddress, quoteAddress);
        if (quoteAddress == stETH) {
            swap = getSwap(baseAddress, wstETH);
        }
        require(address(swap) != address(0), "Unknown swap");

        swap.fund().trancheTransferFrom(
            swap.baseTranche(),
            msg.sender,
            address(swap),
            baseIn,
            version
        );
        if (msg.value > 0) {
            require(msg.value == quoteIn); // sanity check
            IWrappedERC20(quoteAddress).deposit{value: quoteIn}();
            IERC20(quoteAddress).safeTransfer(address(swap), quoteIn);
        } else if (quoteAddress == stETH) {
            IERC20(stETH).safeTransferFrom(msg.sender, address(this), quoteIn);
            IERC20(stETH).approve(wstETH, quoteIn);
            quoteIn = IWstETH(wstETH).wrap(quoteIn);
            IERC20(wstETH).safeTransfer(address(swap), quoteIn);
        } else {
            IERC20(quoteAddress).safeTransferFrom(msg.sender, address(swap), quoteIn);
        }

        uint256 lpOut = swap.addLiquidity(version, msg.sender);
        require(lpOut >= minLpOut, "Insufficient output");
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 minAmountOut,
        address[] calldata path,
        address recipient,
        address staking,
        uint256[] calldata versions,
        uint256 deadline
    ) external payable override checkDeadline(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(versions.length == path.length - 1, "Invalid versions");
        IStableSwap[] memory swaps;
        bool[] memory isBuy;
        (amounts, swaps, isBuy) = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= minAmountOut, "Insufficient output");

        if (msg.value > 0) {
            require(msg.value == amounts[0]); // sanity check
            IWrappedERC20(path[0]).deposit{value: amounts[0]}();
            IERC20(path[0]).safeTransfer(address(swaps[0]), amounts[0]);
        } else {
            if (isBuy[0]) {
                IERC20(path[0]).safeTransferFrom(msg.sender, address(swaps[0]), amounts[0]);
            } else {
                swaps[0].fund().trancheTransferFrom(
                    swaps[0].baseTranche(),
                    msg.sender,
                    address(swaps[0]),
                    amounts[0],
                    versions[0]
                );
            }
        }

        if (staking == address(0)) {
            _swap(amounts, swaps, isBuy, versions, recipient);
        } else {
            _swap(amounts, swaps, isBuy, versions, staking);
            ShareStaking(staking).deposit(
                swaps[swaps.length - 1].baseTranche(),
                amounts[amounts.length - 1],
                recipient,
                versions[versions.length - 1]
            );
        }
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 maxAmountIn,
        address[] calldata path,
        address recipient,
        address staking,
        uint256[] calldata versions,
        uint256 deadline
    ) external payable override checkDeadline(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(versions.length == path.length - 1, "Invalid versions");
        IStableSwap[] memory swaps;
        bool[] memory isBuy;
        (amounts, swaps, isBuy) = getAmountsIn(amountOut, path);
        require(amounts[0] <= maxAmountIn, "Excessive input");

        if (msg.value > 0) {
            require(msg.value == maxAmountIn); // sanity check
            IWrappedERC20(path[0]).deposit{value: amounts[0]}();
            IERC20(path[0]).safeTransfer(address(swaps[0]), amounts[0]);
        } else {
            if (isBuy[0]) {
                IERC20(path[0]).safeTransferFrom(msg.sender, address(swaps[0]), amounts[0]);
            } else {
                swaps[0].fund().trancheTransferFrom(
                    swaps[0].baseTranche(),
                    msg.sender,
                    address(swaps[0]),
                    amounts[0],
                    versions[0]
                );
            }
        }

        if (staking == address(0)) {
            _swap(amounts, swaps, isBuy, versions, recipient);
        } else {
            _swap(amounts, swaps, isBuy, versions, staking);
            ShareStaking(staking).deposit(
                swaps[swaps.length - 1].baseTranche(),
                amountOut,
                recipient,
                versions[versions.length - 1]
            );
        }
        // refund native token
        if (msg.value > amounts[0]) {
            (bool success, ) = msg.sender.call{value: msg.value - amounts[0]}("");
            require(success, "Transfer failed");
        }
    }

    function swapExactTokensForTokensUnwrap(
        uint256 amountIn,
        uint256 minAmountOut,
        address[] calldata path,
        address recipient,
        uint256[] calldata versions,
        uint256 deadline
    ) external override checkDeadline(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(versions.length == path.length - 1, "Invalid versions");
        IStableSwap[] memory swaps;
        bool[] memory isBuy;
        (amounts, swaps, isBuy) = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= minAmountOut, "Insufficient output");
        if (isBuy[0]) {
            IERC20(path[0]).safeTransferFrom(msg.sender, address(swaps[0]), amounts[0]);
        } else {
            swaps[0].fund().trancheTransferFrom(
                swaps[0].baseTranche(),
                msg.sender,
                address(swaps[0]),
                amounts[0],
                versions[0]
            );
        }
        _swap(amounts, swaps, isBuy, versions, address(this));
        IWrappedERC20(path[path.length - 1]).withdraw(amounts[amounts.length - 1]);
        (bool success, ) = recipient.call{value: amounts[amounts.length - 1]}("");
        require(success, "Transfer failed");
    }

    function swapTokensForExactTokensUnwrap(
        uint256 amountOut,
        uint256 maxAmountIn,
        address[] calldata path,
        address recipient,
        uint256[] calldata versions,
        uint256 deadline
    ) external override checkDeadline(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(versions.length == path.length - 1, "Invalid versions");
        IStableSwap[] memory swaps;
        bool[] memory isBuy;
        (amounts, swaps, isBuy) = getAmountsIn(amountOut, path);
        require(amounts[0] <= maxAmountIn, "Excessive input");
        if (isBuy[0]) {
            IERC20(path[0]).safeTransferFrom(msg.sender, address(swaps[0]), amounts[0]);
        } else {
            swaps[0].fund().trancheTransferFrom(
                swaps[0].baseTranche(),
                msg.sender,
                address(swaps[0]),
                amounts[0],
                versions[0]
            );
        }
        _swap(amounts, swaps, isBuy, versions, address(this));
        IWrappedERC20(path[path.length - 1]).withdraw(amountOut);
        (bool success, ) = recipient.call{value: amountOut}("");
        require(success, "Transfer failed");
    }

    function getAmountsOut(
        uint256 amount,
        address[] memory path
    )
        public
        view
        override
        returns (uint256[] memory amounts, IStableSwap[] memory swaps, bool[] memory isBuy)
    {
        amounts = new uint256[](path.length);
        swaps = new IStableSwap[](path.length - 1);
        isBuy = new bool[](path.length - 1);
        amounts[0] = amount;
        for (uint256 i; i < path.length - 1; i++) {
            swaps[i] = getSwap(path[i], path[i + 1]);
            require(address(swaps[i]) != address(0), "Unknown swap");
            if (path[i] == swaps[i].baseAddress()) {
                amounts[i + 1] = swaps[i].getQuoteOut(amounts[i]);
            } else {
                isBuy[i] = true;
                amounts[i + 1] = swaps[i].getBaseOut(amounts[i]);
            }
        }
    }

    function getAmountsIn(
        uint256 amount,
        address[] memory path
    )
        public
        view
        override
        returns (uint256[] memory amounts, IStableSwap[] memory swaps, bool[] memory isBuy)
    {
        amounts = new uint256[](path.length);
        swaps = new IStableSwap[](path.length - 1);
        isBuy = new bool[](path.length - 1);
        amounts[amounts.length - 1] = amount;
        for (uint256 i = path.length - 1; i > 0; i--) {
            swaps[i - 1] = getSwap(path[i - 1], path[i]);
            require(address(swaps[i - 1]) != address(0), "Unknown swap");
            if (path[i] == swaps[i - 1].baseAddress()) {
                isBuy[i - 1] = true;
                amounts[i - 1] = swaps[i - 1].getQuoteIn(amounts[i]);
            } else {
                amounts[i - 1] = swaps[i - 1].getBaseIn(amounts[i]);
            }
        }
    }

    function _swap(
        uint256[] memory amounts,
        IStableSwap[] memory swaps,
        bool[] memory isBuy,
        uint256[] calldata versions,
        address recipient
    ) private {
        for (uint256 i = 0; i < swaps.length; i++) {
            address to = i < swaps.length - 1 ? address(swaps[i + 1]) : recipient;
            if (!isBuy[i]) {
                swaps[i].sell(versions[i], amounts[i + 1], to, new bytes(0));
            } else {
                swaps[i].buy(versions[i], amounts[i + 1], to, new bytes(0));
            }
        }
    }

    modifier checkDeadline(uint256 deadline) {
        require(block.timestamp <= deadline, "Transaction too old");
        _;
    }
}
