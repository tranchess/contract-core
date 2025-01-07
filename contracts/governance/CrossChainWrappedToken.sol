// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../layerzero/NonblockingLzApp.sol";

contract CrossChainWrappedToken is ERC20, NonblockingLzApp {
    event CrossChainWrapped(uint256 amount);
    event CrossChainUnwrapping(address account, uint256 amount);

    uint16 public immutable subLzChainID;

    constructor(
        string memory name_,
        string memory symbol_,
        uint16 subLzChainID_,
        address endpoint_
    ) public ERC20(name_, symbol_) NonblockingLzApp(endpoint_) {
        subLzChainID = subLzChainID_;
    }

    function unwrap(address to, uint256 amount, bytes memory adapterParams) external payable {
        require(amount != 0);
        _burn(msg.sender, amount);

        _checkGasLimit(subLzChainID, 0 /*type*/, adapterParams, 0 /*extraGas*/);
        _lzSend(
            subLzChainID,
            abi.encode(to, amount),
            msg.sender == tx.origin ? msg.sender : payable(owner()), // To avoid reentrancy
            address(0x0),
            adapterParams,
            msg.value
        );
        emit CrossChainUnwrapping(to, amount);
    }

    /// @dev Receive the cross-chain message and mint the wrapped token
    function _nonblockingLzReceive(
        uint16,
        bytes memory,
        uint64,
        bytes memory data
    ) internal override {
        uint256 amount = abi.decode(data, (uint256));
        _mint(owner(), amount);
        emit CrossChainWrapped(amount);
    }
}
