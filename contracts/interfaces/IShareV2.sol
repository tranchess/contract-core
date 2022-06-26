// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IShareV2 is IERC20 {
    function fundEmitTransfer(
        address sender,
        address recipient,
        uint256 amount
    ) external;

    function fundEmitApproval(
        address owner,
        address spender,
        uint256 amount
    ) external;
}
