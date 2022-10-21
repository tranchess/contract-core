// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

interface IAnyCallV6Proxy {
    function executor() external view returns (address);

    function anyCall(
        address to,
        bytes calldata data,
        address fallbackAddress,
        uint256 toChainID,
        uint256 flags
    ) external payable;
}

interface IAnyCallExecutor {
    function context()
        external
        view
        returns (
            address from,
            uint256 fromChainID,
            uint256 nonce
        );
}

interface IAnyFallback {
    function anyFallback(address to, bytes calldata data) external;
}

abstract contract AnyCallAppBase {
    uint256 private constant ANY_CALL_FLAG_PAY_ON_DEST = 0;
    uint256 private constant ANY_CALL_FLAG_PAY_ON_SRC = 2;

    address public immutable anyCallProxy;
    uint256 public immutable anyCallFlag;
    bool public immutable anyCallExecuteFallback;

    constructor(
        address anyCallProxy_,
        bool anyCallPayOnSrc_,
        bool anyCallExecuteFallback_
    ) internal {
        anyCallProxy = anyCallProxy_;
        anyCallFlag = anyCallPayOnSrc_ ? ANY_CALL_FLAG_PAY_ON_SRC : ANY_CALL_FLAG_PAY_ON_DEST;
        anyCallExecuteFallback = anyCallExecuteFallback_;
    }

    modifier onlyExecutor() {
        require(msg.sender == IAnyCallV6Proxy(anyCallProxy).executor());
        _;
    }

    function _anyCall(
        address to,
        uint256 toChainID,
        bytes memory data
    ) internal {
        uint256 callValue = anyCallFlag == ANY_CALL_FLAG_PAY_ON_DEST ? 0 : msg.value;
        address fallbackAddress = anyCallExecuteFallback ? address(this) : address(0);
        IAnyCallV6Proxy(anyCallProxy).anyCall{value: callValue}(
            to,
            data,
            fallbackAddress,
            toChainID,
            anyCallFlag
        );
    }

    function anyExecute(bytes calldata data)
        external
        onlyExecutor
        returns (bool success, bytes memory result)
    {
        (address from, uint256 fromChainID, ) =
            IAnyCallExecutor(IAnyCallV6Proxy(anyCallProxy).executor()).context();
        bytes4 selector = data.length >= 32 ? bytes4(abi.decode(data[0:32], (bytes32))) : bytes4(0);
        if (from == address(this) && selector == IAnyFallback.anyFallback.selector) {
            (address to, bytes memory fallbackData) =
                abi.decode(data[4:data.length], (address, bytes));
            require(_checkAnyFallbackTo(to, fromChainID), "Invalid anyFallback to");
            _anyFallback(fallbackData);
            return (true, "");
        }

        require(
            _checkAnyExecuteFrom(from, fromChainID) && from != address(0),
            "Invalid anyExecute from"
        );
        _anyExecute(fromChainID, data);
        return (true, "");
    }

    function _checkAnyExecuteFrom(address from, uint256 fromChainID)
        internal
        virtual
        returns (bool);

    function _checkAnyFallbackTo(address to, uint256 fromChainID) internal virtual returns (bool);

    function _anyExecute(uint256 fromChainID, bytes calldata data) internal virtual;

    function _anyFallback(bytes memory data) internal virtual;
}
