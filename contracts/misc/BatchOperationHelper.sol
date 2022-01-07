// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "../exchange/Exchange.sol";

interface IClaim {
    function claim(address account) external;

    function claimAndUnwrap(address account) external;
}

interface IClaimRewards {
    function claimRewards(address account) external;

    function claimRewardsAndUnwrap(address account) external;
}

contract BatchOperationHelper {
    using SafeMath for uint256;

    string public constant VERSION = "1.1.1";

    uint256 private constant ENCODED_EXCHANGE_BIT = 224;
    uint256 private constant ENCODED_MAKER_BIT = 192;
    uint256 private constant ENCODED_EPOCH_MASK = 2**64 - 1;

    /// @dev Each value of `encodedEpochs` encodes an exchange index (32 bits),
    ///      a maker/taker flag (32 bits, 0 for maker, 1 for taker) and the epoch timestamp.
    /// @return totalTokenAmounts An array of (exchanges.length * 3) values, containing the amount
    ///         of three tokens settled in each exchange
    /// @return totalQuoteAmount Total amount of quote tokens returned to the account.
    function settleTrades(
        address[] calldata exchanges,
        uint256[] calldata encodedEpochs,
        address account
    ) external returns (uint256[] memory totalTokenAmounts, uint256 totalQuoteAmount) {
        totalTokenAmounts = new uint256[](exchanges.length * 3);
        uint256 count = encodedEpochs.length;
        for (uint256 i = 0; i < count; i++) {
            uint256 encodedEpoch = encodedEpochs[i];
            uint256 exchangeIndex = encodedEpoch >> ENCODED_EXCHANGE_BIT;
            Exchange exchange = Exchange(exchanges[exchangeIndex]);
            uint256 epoch = encodedEpoch & ENCODED_EPOCH_MASK;
            (uint256 amountM, uint256 amountA, uint256 amountB, uint256 quoteAmount) =
                ((encodedEpoch >> ENCODED_MAKER_BIT) & 0x1 == 0)
                    ? exchange.settleMaker(account, epoch)
                    : exchange.settleTaker(account, epoch);
            totalTokenAmounts[exchangeIndex * 3] += amountM;
            totalTokenAmounts[exchangeIndex * 3 + 1] += amountA;
            totalTokenAmounts[exchangeIndex * 3 + 2] += amountB;
            totalQuoteAmount = totalQuoteAmount.add(quoteAmount);
        }
    }

    function batchClaim(address[] calldata contracts, address account) public {
        uint256 count = contracts.length;
        for (uint256 i = 0; i < count; i++) {
            IClaim(contracts[i]).claim(account);
        }
    }

    function batchClaimAndUnwrap(
        address[] calldata contracts,
        address[] calldata wrappedContracts,
        address account
    ) external {
        batchClaim(contracts, account);
        uint256 count = wrappedContracts.length;
        for (uint256 i = 0; i < count; i++) {
            IClaim(wrappedContracts[i]).claimAndUnwrap(account);
        }
    }

    function batchClaimRewards(address[] calldata contracts, address account) public {
        uint256 count = contracts.length;
        for (uint256 i = 0; i < count; i++) {
            IClaimRewards(contracts[i]).claimRewards(account);
        }
    }

    function batchClaimRewardsAndUnwrap(
        address[] calldata contracts,
        address[] calldata wrappedContracts,
        address account
    ) external {
        batchClaimRewards(contracts, account);
        uint256 count = wrappedContracts.length;
        for (uint256 i = 0; i < count; i++) {
            IClaimRewards(wrappedContracts[i]).claimRewardsAndUnwrap(account);
        }
    }
}
