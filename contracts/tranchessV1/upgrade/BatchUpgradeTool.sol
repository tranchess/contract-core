// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../interfaces/IPrimaryMarketV2.sol";
import "../exchange/Exchange.sol";
import "./UpgradeTool.sol";

contract BatchUpgradeTool {
    using SafeMath for uint256;

    uint256 private constant ENCODED_EXCHANGE_BIT = 224;
    uint256 private constant ENCODED_MAKER_BIT = 192;
    uint256 private constant ENCODED_EPOCH_MASK = 2**64 - 1;

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
        uint256[] calldata encodedEpochs,
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

        for (uint256 i = 0; i < encodedEpochs.length; i++) {
            uint256 encodedEpoch = encodedEpochs[i];
            uint256 exchangeIndex = encodedEpoch >> ENCODED_EXCHANGE_BIT;
            Exchange exchange =
                Exchange(address(UpgradeTool(upgradeTools[exchangeIndex]).oldExchange()));
            uint256 epoch = encodedEpoch & ENCODED_EPOCH_MASK;
            (, , , uint256 quoteAmount) =
                ((encodedEpoch >> ENCODED_MAKER_BIT) & 0x1 == 0)
                    ? exchange.settleMaker(account, epoch)
                    : exchange.settleTaker(account, epoch);
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
