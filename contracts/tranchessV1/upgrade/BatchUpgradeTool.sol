// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../interfaces/IPrimaryMarketV2.sol";
import "../exchange/ExchangeV3.sol";
import "./UpgradeTool.sol";

contract BatchUpgradeTool {
    using SafeMath for uint256;

    /// @dev Each value of `encodedEpochs` encodes an exchange index (32 bits),
    ///      a maker/taker flag (32 bits, 0 for maker, 1 for taker) and the epoch timestamp.
    /// @return tokenAmounts An array of (upgradeTools.length * 3) values, containing the amount
    ///         of three tokens upgraded for each Fund
    /// @return underlyingAmounts An array of (oldPrimaryMarkets.length + oldWrappedPrimaryMarkets.length)
    ///         values, containing the amount of underlying tokens claimed from each primary market
    /// @return totalQuoteAmount Total amount of quote tokens returned to the account.
    /// @return totalRewards Total amount of CHESS claimed by the account.
    function batchProtocolUpgrade(
        address[] calldata oldPrimaryMarkets,
        address[] calldata oldWrappedPrimaryMarkets,
        address[] calldata upgradeTools,
        uint256[] calldata encodedData,
        address account
    )
        external
        returns (
            uint256[] memory tokenAmounts,
            uint256[] memory underlyingAmounts,
            uint256 totalQuoteAmount,
            uint256 totalRewards
        )
    {
        underlyingAmounts = new uint256[](
            oldPrimaryMarkets.length + oldWrappedPrimaryMarkets.length
        );
        for (uint256 i = 0; i < oldPrimaryMarkets.length; i++) {
            (, underlyingAmounts[i]) = IPrimaryMarket(oldPrimaryMarkets[i]).claim(account);
        }
        for (uint256 i = 0; i < oldWrappedPrimaryMarkets.length; i++) {
            (, underlyingAmounts[i + oldPrimaryMarkets.length]) = IPrimaryMarketV2(
                oldWrappedPrimaryMarkets[i]
            )
                .claimAndUnwrap(account);
        }

        /// @dev `encodedData` contains two types of data:
        ///      - unsettled epochs
        ///      - bid orders
        //       Unsettled epochs are encoded as follows:
        //       Bit  255       | 0 (constant)
        //       Bit [224, 228) | exchangeIndex
        //       Bit 192        | 0 (maker), 1(taker)
        //       Bit [0, 64)    | epoch
        //       Bid orders are encoded as follows:
        //       Bit  255       | 1 (constant)
        //       Bit [224, 228) | exchangeIndex
        //       Bit [76, 80)   | version
        //       Bit [72, 76)   | tranche
        //       Bit [64, 72)   | pdLevel
        //       Bit [0, 64)    | index
        for (uint256 i = 0; i < encodedData.length; i++) {
            uint256 encodedDatum = encodedData[i];
            uint256 exchangeIndex = (encodedDatum >> 224) & 0xF;
            ExchangeV3 exchange =
                ExchangeV3(address(UpgradeTool(upgradeTools[exchangeIndex]).oldExchange()));
            uint256 quoteAmount;
            if ((encodedDatum >> 255) == 0) {
                // unsettled epochs
                uint256 epoch = encodedDatum & 0xFFFFFFFFFFFFFFFF;
                (, , , quoteAmount) = ((encodedDatum >> 192) & 0x1 == 0)
                    ? exchange.settleMaker(account, epoch)
                    : exchange.settleTaker(account, epoch);
            } else {
                // bid orders
                uint256 version = (encodedDatum >> 76) & 0xF;
                uint256 tranche = (encodedDatum >> 72) & 0xF;
                uint256 pdLevel = (encodedDatum >> 64) & 0xFF;
                uint256 index = encodedDatum & 0xFFFFFFFFFFFFFFFF;
                quoteAmount = exchange.cancelBid(version, tranche, pdLevel, index);
            }
            totalQuoteAmount = totalQuoteAmount.add(quoteAmount);
        }

        tokenAmounts = new uint256[](upgradeTools.length * 3);
        for (uint256 i = 0; i < upgradeTools.length; i++) {
            UpgradeTool tool = UpgradeTool(upgradeTools[i]);
            uint256 claimedRewards;
            (
                tokenAmounts[i * 3],
                tokenAmounts[i * 3 + 1],
                tokenAmounts[i * 3 + 2],
                claimedRewards
            ) = tool.protocolUpgrade(account);
            totalRewards = totalRewards.add(claimedRewards);
        }
    }
}
