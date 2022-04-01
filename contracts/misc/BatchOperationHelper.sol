// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";

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
