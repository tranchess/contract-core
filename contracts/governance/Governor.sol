// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/TimelockController.sol";

import "../interfaces/IVotingEscrow.sol";

contract Governor is Ownable {
    using SafeMath for uint256;

    struct Proposal {
        // Unique id for looking up a proposal
        uint256 id;
        // Creator of the proposal
        address proposer;
        // The timestamp that the proposal will be available for execution, set once the vote succeeds
        uint256 eta;
        // the ordered list of target addresses for calls to be made
        address[] targets;
        // The ordered list of values (i.e. msg.value) to be passed to the calls to be made
        uint256[] values;
        // The ordered list of execution datas to be called
        bytes[] datas;
        bytes32 predecessor;
        bytes32 salt;
        uint256 delay;
        bytes32 timelockId;
        // The timestamp at which voting begins
        uint256 startTimestamp;
        // The timestamp at which voting ends: votes must be cast prior to this timestamp
        uint256 endTimestamp;
        // Current number of votes in favor of this proposal
        uint256 forVotes;
        // Current number of votes in opposition to this proposal
        uint256 againstVotes;
        // Current number of votes for abstaining for this proposal
        uint256 abstainVotes;
        // Flag marking whether the proposal has been canceled
        bool canceled;
        // Flag marking whether the proposal has been executed
        bool executed;
        // Receipts of ballots for the entire set of voters
        mapping(address => Receipt) receipts;
    }

    /// @dev Ballot receipt record for a voter
    struct Receipt {
        // Whether or not a vote has been cast
        bool hasVoted;
        // Whether or not the voter supports the proposal or abstains
        uint256 support;
        // The number of votes the voter had, which were cast
        uint256 votes;
    }

    /// @dev Possible states that a proposal may be in
    enum ProposalState {Pending, Active, Canceled, Defeated, Succeeded, Queued, Expired, Executed}

    /// @dev An event emitted when a new proposal is created
    event ProposalCreated(
        uint256 id,
        address proposer,
        address[] targets,
        uint256[] values,
        bytes[] datas,
        uint256 startTimestamp,
        uint256 endTimestamp,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    );

    /// @dev An event emitted when a vote has been cast on a proposal
    /// @param voter The address which casted a vote
    /// @param proposalId The proposal id which was voted on
    /// @param support Support value for the vote. 0=against, 1=for, 2=abstain
    /// @param votes Number of votes which were cast by the voter
    /// @param reason The reason given for the vote by the voter
    event VoteCast(
        address indexed voter,
        uint256 proposalId,
        uint256 support,
        uint256 votes,
        string reason
    );

    /// @dev An event emitted when a proposal has been canceled
    event ProposalCanceled(uint256 id);

    /// @dev An event emitted when a proposal has been queued in the Timelock
    event ProposalQueued(uint256 id, uint256 eta);

    /// @dev An event emitted when a proposal has been executed in the Timelock
    event ProposalExecuted(uint256 id);

    /// @dev An event emitted when the voting delay is set
    event VotingDelaySet(uint256 oldVotingDelay, uint256 newVotingDelay);

    /// @dev An event emitted when the voting period is set
    event VotingPeriodSet(uint256 oldVotingPeriod, uint256 newVotingPeriod);

    /// @dev Emitted when implementation is changed
    event NewImplementation(address oldImplementation, address newImplementation);

    /// @dev Emitted when proposal threshold is set
    event ProposalThresholdSet(uint256 oldProposalThreshold, uint256 newProposalThreshold);

    /// @dev Emitted when whitelist account expiration is set
    event WhitelistAccountExpirationSet(address account, uint256 expiration);

    /// @dev Emitted when the whitelistGuardian is set
    event WhitelistGuardianSet(address oldGuardian, address newGuardian);

    /// @dev The name of this contract
    string public constant name = "Tranchess Governor";

    /// @dev The minimum setable proposal threshold
    uint256 public constant MIN_PROPOSAL_THRESHOLD = 50000e18; // 50,000 veCHESS

    /// @dev The maximum setable proposal threshold
    uint256 public constant MAX_PROPOSAL_THRESHOLD = 100000e18; //100,000 veCHESS

    /// @dev The minimum setable voting period
    uint256 public constant MIN_VOTING_PERIOD = 5760; // About 24 hours

    /// @dev The max setable voting period
    uint256 public constant MAX_VOTING_PERIOD = 80640; // About 2 weeks

    /// @dev The min setable voting delay
    uint256 public constant MIN_VOTING_DELAY = 1;

    /// @dev The max setable voting delay
    uint256 public constant MAX_VOTING_DELAY = 40320; // About 1 week

    /// @dev The number of votes in support of a proposal required in order for a quorum to be reached and for a vote to succeed
    uint256 public constant quorumVotes = 400000e18; // 400,000 = 4% of veCHESS

    /// @dev The maximum number of actions that can be included in a proposal
    uint256 public constant proposalMaxOperations = 10; // 10 actions

    /// @dev The EIP-712 typehash for the contract's domain
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    /// @dev The EIP-712 typehash for the ballot struct used by the contract
    bytes32 public constant BALLOT_TYPEHASH =
        keccak256("Ballot(uint256 proposalId,uint256 support)");

    uint256 public constant GRACE_PERIOD = 14 days;

    /// @dev The delay before voting on a proposal may take place, once proposed, in seconds
    uint256 public votingDelay;

    /// @dev The duration of voting on a proposal, in seconds
    uint256 public votingPeriod;

    /// @dev The number of votes required in order for a voter to become a proposer
    uint256 public proposalThreshold;

    /// @dev Initial proposal id set at become
    uint256 public initialProposalId;

    /// @dev The total number of proposals
    uint256 public proposalCount;

    /// @dev The address of the Timelock
    TimelockController public timelock;

    /// @dev The address of the vote-locked CHESS token
    IVotingEscrow public votingEscrow;

    /// @dev The official record of all proposals ever proposed
    mapping(uint256 => Proposal) public proposals;

    /// @dev The latest proposal for each proposer
    mapping(address => uint256) public latestProposalIds;

    /// @dev Stores the expiration of account whitelist status as a timestamp
    mapping(address => uint256) public whitelistAccountExpirations;

    /// @dev Address which manages whitelisted proposals and whitelist accounts
    address public whitelistGuardian;

    /// @notice Used to initialize the contract during delegator contructor
    /// @param timelock_ The address of the Timelock
    /// @param votingEscrow_ The address of the veCHESS token
    /// @param votingPeriod_ The initial voting period
    /// @param votingDelay_ The initial voting delay
    /// @param proposalThreshold_ The initial proposal threshold
    constructor(
        address payable timelock_,
        address votingEscrow_,
        uint256 votingPeriod_,
        uint256 votingDelay_,
        uint256 proposalThreshold_
    ) public {
        require(timelock_ != address(0), "Governor::initialize: invalid timelock address");
        require(votingEscrow_ != address(0), "Governor::initialize: invalid voting escrow address");
        require(
            votingPeriod_ >= MIN_VOTING_PERIOD && votingPeriod_ <= MAX_VOTING_PERIOD,
            "Governor::initialize: invalid voting period"
        );
        require(
            votingDelay_ >= MIN_VOTING_DELAY && votingDelay_ <= MAX_VOTING_DELAY,
            "Governor::initialize: invalid voting delay"
        );
        require(
            proposalThreshold_ >= MIN_PROPOSAL_THRESHOLD &&
                proposalThreshold_ <= MAX_PROPOSAL_THRESHOLD,
            "Governor::initialize: invalid proposal threshold"
        );

        timelock = TimelockController(timelock_);
        votingEscrow = IVotingEscrow(votingEscrow_);
        votingPeriod = votingPeriod_;
        votingDelay = votingDelay_;
        proposalThreshold = proposalThreshold_;
    }

    /// @notice Function used to propose a new proposal. Sender must have delegates above the proposal threshold
    /// @param targets Target addresses for proposal calls
    /// @param values Eth values for proposal calls
    /// @param datas Execution datas for proposal calls
    /// @param predecessor The dependency between operatoins if any
    /// @param salt Nonce to disambiguate two otherwise identical operations
    /// @param delay Delay for operations, in seconds
    /// @return Proposal id of new proposal
    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory datas,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public returns (uint256) {
        // Reject proposals before initiating as Governor
        require(initialProposalId != 0, "Governor::propose: Governor not active");
        // Allow addresses above proposal threshold and whitelisted addresses to propose
        require(
            votingEscrow.balanceOf(msg.sender) > proposalThreshold || isWhitelisted(msg.sender),
            "Governor::propose: proposer votes below proposal threshold"
        );
        require(
            targets.length == values.length && targets.length == datas.length,
            "Governor::propose: proposal function information arity mismatch"
        );
        require(targets.length != 0, "Governor::propose: must provide actions");
        require(targets.length <= proposalMaxOperations, "Governor::propose: too many actions");

        uint256 latestProposalId = latestProposalIds[msg.sender];
        if (latestProposalId != 0) {
            ProposalState proposersLatestProposalState = state(latestProposalId);
            require(
                proposersLatestProposalState != ProposalState.Active,
                "Governor::propose: one live proposal per proposer, found an already active proposal"
            );
            require(
                proposersLatestProposalState != ProposalState.Pending,
                "Governor::propose: one live proposal per proposer, found an already pending proposal"
            );
        }

        uint256 startTimestamp = block.timestamp.add(votingDelay);
        uint256 endTimestamp = startTimestamp.add(votingPeriod);

        proposalCount++;
        Proposal memory newProposal =
            Proposal({
                id: proposalCount,
                proposer: msg.sender,
                eta: 0,
                targets: targets,
                values: values,
                datas: datas,
                predecessor: predecessor,
                salt: salt,
                delay: delay,
                timelockId: targets.length == 1
                    ? timelock.hashOperation(targets[0], values[0], datas[0], predecessor, salt)
                    : timelock.hashOperationBatch(targets, values, datas, predecessor, salt),
                startTimestamp: startTimestamp,
                endTimestamp: endTimestamp,
                forVotes: 0,
                againstVotes: 0,
                abstainVotes: 0,
                canceled: false,
                executed: false
            });

        proposals[newProposal.id] = newProposal;
        latestProposalIds[newProposal.proposer] = newProposal.id;

        emit ProposalCreated(
            newProposal.id,
            msg.sender,
            targets,
            values,
            datas,
            startTimestamp,
            endTimestamp,
            predecessor,
            salt,
            delay
        );
        return newProposal.id;
    }

    /**
    /// @notice Schedule a proposal of state succeeded
    /// @param proposalId The id of the proposal to queue
      */
    function schedule(uint256 proposalId) external {
        require(
            state(proposalId) == ProposalState.Succeeded,
            "Governor::queue: proposal can only be queued if it is succeeded"
        );
        Proposal storage proposal = proposals[proposalId];
        uint256 eta = block.timestamp.add(proposal.delay);

        if (proposal.targets.length == 1) {
            timelock.schedule(
                proposal.targets[0],
                proposal.values[0],
                proposal.datas[0],
                proposal.predecessor,
                proposal.salt,
                proposal.delay
            );
        } else {
            timelock.scheduleBatch(
                proposal.targets,
                proposal.values,
                proposal.datas,
                proposal.predecessor,
                proposal.salt,
                proposal.delay
            );
        }
        proposal.eta = eta;
        emit ProposalQueued(proposalId, eta);
    }

    /// @notice Executes a queued proposal if eta has passed
    /// @param proposalId The id of the proposal to execute
    function execute(uint256 proposalId) external payable {
        require(
            state(proposalId) == ProposalState.Queued,
            "Governor::execute: proposal can only be executed if it is queued"
        );
        Proposal storage proposal = proposals[proposalId];
        proposal.executed = true;
        if (proposal.targets.length == 1) {
            timelock.execute{value: proposal.values[0]}(
                proposal.targets[0],
                proposal.values[0],
                proposal.datas[0],
                proposal.predecessor,
                proposal.salt
            );
        } else {
            timelock.executeBatch{value: msg.value}(
                proposal.targets,
                proposal.values,
                proposal.datas,
                proposal.predecessor,
                proposal.salt
            );
        }
        emit ProposalExecuted(proposalId);
    }

    /// @notice Cancels a proposal only if sender is the proposer, or proposer delegates dropped below proposal threshold
    /// @param proposalId The id of the proposal to cancel
    function cancel(uint256 proposalId) external {
        require(
            state(proposalId) != ProposalState.Executed,
            "Governor::cancel: cannot cancel executed proposal"
        );

        Proposal storage proposal = proposals[proposalId];

        // Proposer can cancel
        if (msg.sender != proposal.proposer) {
            // Whitelisted proposers can't be canceled for falling below proposal threshold
            if (isWhitelisted(proposal.proposer)) {
                require(
                    votingEscrow.balanceOf(proposal.proposer) < proposalThreshold &&
                        msg.sender == whitelistGuardian,
                    "Governor::cancel: whitelisted proposer"
                );
            } else {
                require(
                    votingEscrow.balanceOf(proposal.proposer) < proposalThreshold,
                    "Governor::cancel: proposer above threshold"
                );
            }
        }

        proposal.canceled = true;
        timelock.cancel(proposal.timelockId);

        emit ProposalCanceled(proposalId);
    }

    /// @notice Gets actions of a proposal
    /// @param proposalId the id of the proposal
    /// @return targets targets of the proposal actions
    /// @return values values of the proposal actions
    /// @return datas datas of the proposal actions
    function getActions(uint256 proposalId)
        external
        view
        returns (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory datas
        )
    {
        Proposal storage p = proposals[proposalId];
        return (p.targets, p.values, p.datas);
    }

    /// @notice Gets the receipt for a voter on a given proposal
    /// @param proposalId the id of proposal
    /// @param voter The address of the voter
    /// @return The voting receipt
    function getReceipt(uint256 proposalId, address voter) external view returns (Receipt memory) {
        return proposals[proposalId].receipts[voter];
    }

    /// @notice Gets the state of a proposal
    /// @param proposalId The id of the proposal
    /// @return Proposal state
    function state(uint256 proposalId) public view returns (ProposalState) {
        require(
            proposalCount >= proposalId && proposalId > initialProposalId,
            "Governor::state: invalid proposal id"
        );
        Proposal storage proposal = proposals[proposalId];
        if (proposal.canceled) {
            return ProposalState.Canceled;
        } else if (block.timestamp <= proposal.startTimestamp) {
            return ProposalState.Pending;
        } else if (block.timestamp <= proposal.endTimestamp) {
            return ProposalState.Active;
        } else if (proposal.forVotes <= proposal.againstVotes || proposal.forVotes < quorumVotes) {
            return ProposalState.Defeated;
        } else if (proposal.eta == 0) {
            return ProposalState.Succeeded;
        } else if (proposal.executed) {
            return ProposalState.Executed;
        } else if (block.timestamp >= proposal.eta.add(GRACE_PERIOD)) {
            return ProposalState.Expired;
        } else {
            return ProposalState.Queued;
        }
    }

    /// @notice Cast a vote for a proposal
    /// @param proposalId The id of the proposal to vote on
    /// @param support The support value for the vote. 0=against, 1=for, 2=abstain
    function castVote(uint256 proposalId, uint256 support) external {
        emit VoteCast(
            msg.sender,
            proposalId,
            support,
            castVoteInternal(msg.sender, proposalId, support),
            ""
        );
    }

    /// @notice Cast a vote for a proposal with a reason
    /// @param proposalId The id of the proposal to vote on
    /// @param support The support value for the vote. 0=against, 1=for, 2=abstain
    /// @param reason The reason given for the vote by the voter
    function castVoteWithReason(
        uint256 proposalId,
        uint256 support,
        string calldata reason
    ) external {
        emit VoteCast(
            msg.sender,
            proposalId,
            support,
            castVoteInternal(msg.sender, proposalId, support),
            reason
        );
    }

    /// @notice Cast a vote for a proposal by signature
    /// @dev External function that accepts EIP-712 signatures for voting on proposals.
    function castVoteBySig(
        uint256 proposalId,
        uint256 support,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        bytes32 domainSeparator =
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), _getChainId(), address(this))
            );
        bytes32 structHash = keccak256(abi.encode(BALLOT_TYPEHASH, proposalId, support));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address signatory = ecrecover(digest, v, r, s);
        require(signatory != address(0), "Governor::castVoteBySig: invalid signature");
        emit VoteCast(
            signatory,
            proposalId,
            support,
            castVoteInternal(signatory, proposalId, support),
            ""
        );
    }

    /// @notice Internal function that caries out voting logic
    /// @param voter The voter that is casting their vote
    /// @param proposalId The id of the proposal to vote on
    /// @param support The support value for the vote. 0=against, 1=for, 2=abstain
    /// @return The number of votes cast
    function castVoteInternal(
        address voter,
        uint256 proposalId,
        uint256 support
    ) internal returns (uint256) {
        require(
            state(proposalId) == ProposalState.Active,
            "Governor::castVoteInternal: voting is closed"
        );
        require(support <= 2, "Governor::castVoteInternal: invalid vote type");
        Proposal storage proposal = proposals[proposalId];
        Receipt storage receipt = proposal.receipts[voter];
        require(receipt.hasVoted == false, "Governor::castVoteInternal: voter already voted");
        uint256 votes = votingEscrow.balanceOfAtTimestamp(voter, proposal.endTimestamp);

        if (support == 0) {
            proposal.againstVotes = proposal.againstVotes.add(votes);
        } else if (support == 1) {
            proposal.forVotes = proposal.forVotes.add(votes);
        } else if (support == 2) {
            proposal.abstainVotes = proposal.abstainVotes.add(votes);
        }

        receipt.hasVoted = true;
        receipt.support = support;
        receipt.votes = votes;

        return votes;
    }

    /// @notice View function which returns if an account is whitelisted
    /// @param account Account to check white list status of
    /// @return If the account is whitelisted
    function isWhitelisted(address account) public view returns (bool) {
        return (whitelistAccountExpirations[account] > now);
    }

    /// @notice Admin function for setting the voting delay
    /// @param newVotingDelay new voting delay, in seconds
    function _setVotingDelay(uint256 newVotingDelay) external onlyOwner {
        require(
            newVotingDelay >= MIN_VOTING_DELAY && newVotingDelay <= MAX_VOTING_DELAY,
            "Governor::_setVotingDelay: invalid voting delay"
        );
        uint256 oldVotingDelay = votingDelay;
        votingDelay = newVotingDelay;

        emit VotingDelaySet(oldVotingDelay, votingDelay);
    }

    /// @notice Admin function for setting the voting period
    /// @param newVotingPeriod new voting period, in seconds
    function setVotingPeriod(uint256 newVotingPeriod) external onlyOwner {
        require(
            newVotingPeriod >= MIN_VOTING_PERIOD && newVotingPeriod <= MAX_VOTING_PERIOD,
            "Governor::_setVotingPeriod: invalid voting period"
        );
        uint256 oldVotingPeriod = votingPeriod;
        votingPeriod = newVotingPeriod;

        emit VotingPeriodSet(oldVotingPeriod, votingPeriod);
    }

    /// @notice Admin function for setting the proposal threshold
    /// @dev newProposalThreshold must be greater than the hardcoded min
    /// @param newProposalThreshold new proposal threshold
    function setProposalThreshold(uint256 newProposalThreshold) external onlyOwner {
        require(
            newProposalThreshold >= MIN_PROPOSAL_THRESHOLD &&
                newProposalThreshold <= MAX_PROPOSAL_THRESHOLD,
            "Governor::_setProposalThreshold: invalid proposal threshold"
        );
        uint256 oldProposalThreshold = proposalThreshold;
        proposalThreshold = newProposalThreshold;

        emit ProposalThresholdSet(oldProposalThreshold, proposalThreshold);
    }

    /// @notice Admin function for setting the whitelist expiration as a timestamp for an account. Whitelist status allows accounts to propose without meeting threshold
    /// @param account Account address to set whitelist expiration for
    /// @param expiration Expiration for account whitelist status as timestamp (if now < expiration, whitelisted)
    function setWhitelistAccountExpiration(address account, uint256 expiration) external {
        require(
            msg.sender == owner() || msg.sender == whitelistGuardian,
            "Governor::_setWhitelistAccountExpiration: admin only"
        );
        whitelistAccountExpirations[account] = expiration;

        emit WhitelistAccountExpirationSet(account, expiration);
    }

    /// @notice Admin function for setting the whitelistGuardian. WhitelistGuardian can cancel proposals from whitelisted addresses
    /// @param account Account to set whitelistGuardian to (0x0 to remove whitelistGuardian)
    function setWhitelistGuardian(address account) external onlyOwner {
        address oldGuardian = whitelistGuardian;
        whitelistGuardian = account;

        emit WhitelistGuardianSet(oldGuardian, whitelistGuardian);
    }

    function _getChainId() private pure returns (uint256) {
        uint256 chainId;
        assembly {
            chainId := chainid()
        }
        return chainId;
    }
}
