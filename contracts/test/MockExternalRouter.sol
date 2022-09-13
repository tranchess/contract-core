// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

contract MockExternalRouter {
    using SafeERC20 for IERC20;

    // keccak256(path) => amountOut => amountIn
    mapping(bytes32 => mapping(uint256 => uint256)) public nextIn;

    // keccak256(path) => amountIn => amountOut
    mapping(bytes32 => mapping(uint256 => uint256)) public nextOut;

    function setNextSwap(
        address[] memory path,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        nextIn[keccak256(abi.encode(path))][amountOut] = amountIn;
        nextOut[keccak256(abi.encode(path))][amountIn] = amountOut;
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        uint256 amountIn = nextIn[keccak256(abi.encode(path))][amountOut];
        require(amountIn != 0, "No mock for the swap");
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        amounts[0] = nextIn[keccak256(abi.encode(path))][amountOut];
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "Deadline");
        uint256 amountOut = nextOut[keccak256(abi.encode(path))][amountIn];
        require(amountOut != 0, "No mock for the swap");
        require(amountOut >= amountOutMin, "MockExternalRouter: Insufficient output");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = amountOut;
        nextIn[keccak256(abi.encode(path))][amountOut] = 0;
        nextOut[keccak256(abi.encode(path))][amountIn] = 0;
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[path.length - 1]).safeTransfer(to, amountOut);
    }
}
