// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "../layerzero/NonblockingLzApp.sol";

contract CrossChainWrapper is NonblockingLzApp {
    event CrossChainWrapping(uint256 amount);
    event CrossChainUnwrapped(address account, uint256 amount);

    using SafeERC20 for IERC20;

    uint16 public immutable mainLzChainID;
    IERC20 public immutable token;

    constructor(
        uint16 mainLzChainID_,
        address token_,
        address endpoint_
    ) public NonblockingLzApp(endpoint_) {
        mainLzChainID = mainLzChainID_;
        token = IERC20(token_);
    }

    function wrap(uint256 amount, bytes memory adapterParams) external payable {
        token.safeTransferFrom(msg.sender, address(this), amount);

        _checkGasLimit(mainLzChainID, 0 /*type*/, adapterParams, 0 /*extraGas*/);
        _lzSend(
            mainLzChainID,
            abi.encode(amount),
            msg.sender == tx.origin ? msg.sender : payable(owner()), // To avoid reentrancy
            address(0x0),
            adapterParams,
            msg.value
        );

        emit CrossChainWrapping(amount);
    }

    /// @dev Receive the cross-chain message and unwrap the token
    function _nonblockingLzReceive(
        uint16,
        bytes memory,
        uint64,
        bytes memory data
    ) internal override {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        token.safeTransfer(to, amount);
        emit CrossChainUnwrapped(to, amount);
    }
}
