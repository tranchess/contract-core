// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "../interfaces/IBallot.sol";

interface IFeeDistributor {
    function syncWithVotingEscrow(address account) external;
}

contract VotingEscrowHelper {
    IFeeDistributor public immutable distributor;
    IBallot public immutable ballot;

    constructor(address distributor_, address ballot_) public {
        distributor = IFeeDistributor(distributor_);
        ballot = IBallot(ballot_);
    }

    function syncWithFeeDistributor(address account) external {
        distributor.syncWithVotingEscrow(account);
    }

    function syncWithFeeDistributorAndBallot(address account) external {
        ballot.syncWithVotingEscrow(account);
        distributor.syncWithVotingEscrow(account);
    }
}
