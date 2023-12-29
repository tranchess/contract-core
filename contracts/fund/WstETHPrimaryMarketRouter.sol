// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../interfaces/IPrimaryMarketV5.sol";
import "../interfaces/IFundV3.sol";
import "../interfaces/IWstETH.sol";
import "../interfaces/ITrancheIndexV2.sol";

contract WstETHPrimaryMarketRouter is ITrancheIndexV2 {
    using SafeERC20 for IERC20;

    IPrimaryMarketV5 public immutable primaryMarket;
    IFundV3 public immutable fund;
    address private immutable _wstETH;
    address private immutable _stETH;
    address private immutable _tokenB;

    constructor(address pm) public {
        primaryMarket = IPrimaryMarketV5(pm);
        IFundV3 fund_ = IFundV3(IPrimaryMarketV5(pm).fund());
        fund = fund_;
        _wstETH = fund_.tokenUnderlying();
        _stETH = IWstETH(fund_.tokenUnderlying()).stETH();
        _tokenB = fund_.tokenB();
    }

    function create(
        address recipient,
        bool needWrap,
        uint256 underlying,
        uint256 minOutQ,
        uint256 version
    ) public returns (uint256 outQ) {
        if (needWrap) {
            IERC20(_stETH).safeTransferFrom(msg.sender, address(this), underlying);
            underlying = IWstETH(_wstETH).wrap(underlying);
            IERC20(_wstETH).safeTransfer(address(primaryMarket), underlying);
        } else {
            IERC20(_wstETH).safeTransferFrom(msg.sender, address(primaryMarket), underlying);
        }

        outQ = primaryMarket.create(recipient, minOutQ, version);
    }

    function createAndSplit(
        uint256 underlying,
        bool needWrap,
        uint256 minOutQ,
        uint256 version
    ) external {
        // Create QUEEN
        uint256 outQ = create(address(this), needWrap, underlying, minOutQ, version);

        // Split QUEEN into BISHOP and ROOK
        (uint256 outB, uint256 outR) = primaryMarket.split(address(this), outQ, version);

        fund.trancheTransfer(TRANCHE_B, msg.sender, outB, version);
        fund.trancheTransfer(TRANCHE_R, msg.sender, outR, version);
    }
}
