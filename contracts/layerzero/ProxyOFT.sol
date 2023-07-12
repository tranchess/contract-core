// SPDX-License-Identifier: MIT

pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "./OFTCore.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

contract ProxyOFT is OFTCore {
    using SafeERC20 for IERC20;

    IERC20 internal immutable innerToken;

    constructor(address _lzEndpoint, address _token) public OFTCore(_lzEndpoint) {
        innerToken = IERC20(_token);
    }

    function circulatingSupply() public view virtual override returns (uint256) {
        return innerToken.totalSupply() - innerToken.balanceOf(address(this));
    }

    function token() public view virtual override returns (address) {
        return address(innerToken);
    }

    function _debitFrom(
        address _from,
        uint16,
        bytes memory,
        uint256 _amount
    ) internal virtual override returns (uint256) {
        require(_from == _msgSender(), "ProxyOFT: owner is not send caller");
        uint256 before = innerToken.balanceOf(address(this));
        innerToken.safeTransferFrom(_from, address(this), _amount);
        return innerToken.balanceOf(address(this)) - before;
    }

    function _creditTo(
        uint16,
        address _toAddress,
        uint256 _amount
    ) internal virtual override returns (uint256) {
        uint256 before = innerToken.balanceOf(_toAddress);
        innerToken.safeTransfer(_toAddress, _amount);
        return innerToken.balanceOf(_toAddress) - before;
    }
}
