// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../interfaces/IPrimaryMarketV2.sol";
import "../fund/PrimaryMarket.sol";
import "../exchange/ExchangeV3.sol";
import "./UpgradeTool.sol";

contract BatchUpgradeTool {
    using SafeMath for uint256;

    /// @dev `encodedData` consists of two types of data:
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
            if (address(tool) == address(0)) {
                continue;
            }
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

    /// @notice Same as `batchProtocolUpgrade` but returns minimal parameters that should be used
    ///         to call `batchProtocolUpgrade`.
    function batchProtocolUpgradeParameters(
        address[] memory oldPrimaryMarkets,
        address[] memory oldWrappedPrimaryMarkets,
        address[] memory upgradeTools,
        uint256[] memory encodedData,
        address account
    )
        external
        returns (
            address[] memory,
            address[] memory,
            address[] memory,
            uint256[] memory
        )
    {
        bool[] memory requiredTools = new bool[](upgradeTools.length);
        _filterPrimaryMarkets(1, oldPrimaryMarkets, upgradeTools, requiredTools, account);
        _filterPrimaryMarkets(2, oldWrappedPrimaryMarkets, upgradeTools, requiredTools, account);
        _filterEncodedData(encodedData, upgradeTools, requiredTools, account);
        _filterUpgradeTools(upgradeTools, requiredTools, account);
        return (oldPrimaryMarkets, oldWrappedPrimaryMarkets, upgradeTools, encodedData);
    }

    function _filterPrimaryMarkets(
        uint256 fundVersion,
        address[] memory primaryMarkets,
        address[] memory upgradeTools,
        bool[] memory requiredTools,
        address account
    ) private {
        for (uint256 i = 0; i < primaryMarkets.length; i++) {
            (uint256 shares, uint256 underlying) =
                fundVersion == 1
                    ? IPrimaryMarket(primaryMarkets[i]).claim(account)
                    : IPrimaryMarketV2(primaryMarkets[i]).claimAndUnwrap(account);
            if (shares | underlying == 0) {
                primaryMarkets[i] = address(0);
            } else if (shares != 0) {
                address tokenUnderlying = PrimaryMarket(primaryMarkets[i]).fund().tokenUnderlying();
                for (uint256 j = 0; j < upgradeTools.length; j++) {
                    if (
                        address(UpgradeTool(upgradeTools[j]).tokenUnderlying()) == tokenUnderlying
                    ) {
                        requiredTools[j] = true;
                        break;
                    }
                }
            }
        }
        _packAddressArray(primaryMarkets);
    }

    function _filterEncodedData(
        uint256[] memory encodedData,
        address[] memory upgradeTools,
        bool[] memory requiredTools,
        address account
    ) private {
        for (uint256 i = 0; i < encodedData.length; i++) {
            uint256 encodedDatum = encodedData[i];
            uint256 exchangeIndex = (encodedDatum >> 224) & 0xF;
            ExchangeV3 exchange =
                ExchangeV3(address(UpgradeTool(upgradeTools[exchangeIndex]).oldExchange()));
            if ((encodedDatum >> 255) == 0) {
                // unsettled epochs
                uint256 epoch = encodedDatum & 0xFFFFFFFFFFFFFFFF;
                (uint256 amountM, uint256 amountA, uint256 amountB, uint256 quoteAmount) =
                    ((encodedDatum >> 192) & 0x1 == 0)
                        ? exchange.settleMaker(account, epoch)
                        : exchange.settleTaker(account, epoch);
                if (amountM | amountA | amountB | quoteAmount == 0) {
                    encodedData[i] = 0;
                } else {
                    requiredTools[exchangeIndex] = true;
                }
            } else {
                // bid orders
                uint256 version = (encodedDatum >> 76) & 0xF;
                uint256 tranche = (encodedDatum >> 72) & 0xF;
                uint256 pdLevel = (encodedDatum >> 64) & 0xFF;
                uint256 index = encodedDatum & 0xFFFFFFFFFFFFFFFF;
                (address maker, , ) = exchange.getBidOrder(version, tranche, pdLevel, index);
                if (maker != account) {
                    encodedData[i] = 0;
                } else {
                    exchange.cancelBid(version, tranche, pdLevel, index);
                    requiredTools[exchangeIndex] = true;
                }
            }
        }
        _packUintArray(encodedData);
    }

    function _filterUpgradeTools(
        address[] memory upgradeTools,
        bool[] memory requiredTools,
        address account
    ) private {
        for (uint256 i = 0; i < upgradeTools.length; i++) {
            UpgradeTool tool = UpgradeTool(upgradeTools[i]);
            (uint256 r1, uint256 r2, uint256 r3, uint256 r4) = tool.protocolUpgrade(account);
            if (r1 | r2 | r3 | r4 == 0 && !requiredTools[i]) {
                upgradeTools[i] = address(0);
            }
        }
        // Do not pack upgradeTools because encodedData has references to it
    }

    function _packAddressArray(address[] memory array) private pure {
        uint256 newLength = 0;
        for (uint256 i = 0; i < array.length; i++) {
            if (array[i] != address(0)) {
                array[newLength] = array[i];
                newLength += 1;
            }
        }
        assembly {
            mstore(array, newLength)
        }
    }

    function _packUintArray(uint256[] memory array) private pure {
        uint256 newLength = 0;
        for (uint256 i = 0; i < array.length; i++) {
            if (array[i] != 0) {
                array[newLength] = array[i];
                newLength += 1;
            }
        }
        assembly {
            mstore(array, newLength)
        }
    }
}
