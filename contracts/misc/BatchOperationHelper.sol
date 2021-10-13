// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "../exchange/Exchange.sol";

interface IClaim {
    function claim(address account) external;
}

interface IClaimRewards {
    function claimRewards(address account) external;
}

contract BatchOperationHelper {
    using SafeMath for uint256;

    string public constant VERSION = "1.1.1";

    uint256 private constant ENCODED_EXCHANGE_BIT = 224;
    uint256 private constant ENCODED_MAKER_BIT = 192;
    uint256 private constant ENCODED_EPOCH_MASK = 2**64 - 1;

    /// @dev Each value of `encodedEpochs` encodes an exchange index (32 bits),
    ///      a maker/taker flag (32 bits, 0 for maker, 1 for taker) and the epoch timestamp.
    function settleTrades(
        address[] memory exchanges,
        uint256[] calldata encodedEpochs,
        address account
    )
        external
        returns (
            uint256 totalAmountM,
            uint256 totalAmountA,
            uint256 totalAmountB,
            uint256 totalQuoteAmount
        )
    {
        uint256 count = encodedEpochs.length;
        for (uint256 i = 0; i < count; i++) {
            uint256 encodedEpoch = encodedEpochs[i];
            Exchange exchange = Exchange(exchanges[encodedEpoch >> ENCODED_EXCHANGE_BIT]);
            uint256 epoch = encodedEpoch & ENCODED_EPOCH_MASK;
            (uint256 amountM, uint256 amountA, uint256 amountB, uint256 quoteAmount) =
                ((encodedEpoch >> ENCODED_MAKER_BIT) & 0x1 == 0)
                    ? exchange.settleMaker(account, epoch)
                    : exchange.settleTaker(account, epoch);
            totalAmountM = totalAmountM.add(amountM);
            totalAmountA = totalAmountA.add(amountA);
            totalAmountB = totalAmountB.add(amountB);
            totalQuoteAmount = totalQuoteAmount.add(quoteAmount);
        }
    }

    function batchClaim(address[] memory contracts, address account) external {
        uint256 count = contracts.length;
        for (uint256 i = 0; i < count; i++) {
            IClaim(contracts[i]).claim(account);
        }
    }

    function batchClaimRewards(address[] memory exchanges, address account) external {
        uint256 count = exchanges.length;
        for (uint256 i = 0; i < count; i++) {
            IClaimRewards(exchanges[i]).claimRewards(account);
        }
    }
}
