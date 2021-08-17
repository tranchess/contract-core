// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

interface IVotingEscrowSync {
    function syncWithVotingEscrow(address account) external;
}

contract VotingEscrowHelper {
    IVotingEscrowSync public immutable distributor;
    IVotingEscrowSync public immutable ballot;
    IVotingEscrowSync public immutable exchange;

    constructor(
        address distributor_,
        address ballot_,
        address exchange_
    ) public {
        distributor = IVotingEscrowSync(distributor_);
        ballot = IVotingEscrowSync(ballot_);
        exchange = IVotingEscrowSync(exchange_);
    }

    function sync(address account) external {
        distributor.syncWithVotingEscrow(account);
        ballot.syncWithVotingEscrow(account);
        exchange.syncWithVotingEscrow(account);
    }
}
