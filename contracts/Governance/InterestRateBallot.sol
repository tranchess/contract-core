// SPDX-License-Identifier: MIT
pragma experimental ABIEncoderV2;
pragma solidity ^0.6.0;
//import "github.com/OpenZeppelin/openzeppelin-contracts/contracts/math/SafeMath.sol";
//import "github.com/OpenZeppelin/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
//import "github.com/OpenZeppelin/openzeppelin-contracts/contracts/token/ERC777/IERC777.sol";

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interfaces/IToken.sol";
import "../interfaces/IBallot.sol";
import "../interfaces/IFund.sol";
import "../interfaces/IVotingEscrow.sol";

import "../utils/SafeDecimalMath.sol";

contract InterestRateBallot is IBallot {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    uint256 public constant STEP_SIZE = 0.02e18;
    uint256 public constant OPTION_NUMBER = 3;

    // The EIP-712 typehash for the contract's domain
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainID,address verifyingContract)");

    // The EIP-712 typehash for the ballot struct used by the contract
    bytes32 public constant BALLOT_TYPEHASH = keccak256("Ballot(uint256 support)");

    // The name of this contract
    string public constant name = "Tranchess Governor Alpha";

    IVotingEscrow public votingEscrow;

    IFund public fund;

    // The official record of current round
    VotingRound public round;
    uint256[50] public voteDistribution;
    uint256[50] public weightedVoteDistribution;
    mapping(address => Receipt) public receipts;

    constructor(address votingEscrow_, address fund_) public {
        votingEscrow = IVotingEscrow(votingEscrow_);
        fund = IFund(fund_);
    }

    function initialize(uint256 timestamp) public override {
        require(msg.sender == address(fund), "only fund");
        round = VotingRound({
            startTimestamp: block.timestamp,
            endTimestamp: timestamp,
            minRange: 0,
            stepSize: STEP_SIZE,
            totalVotes: 0,
            totalValue: 0,
            optionNumber: OPTION_NUMBER
        });

        emit RoundCreated(
            msg.sender,
            round.startTimestamp,
            round.endTimestamp,
            "Schedule weekly rounds for interest rate adjustments"
        );
    }

    function getOption(uint256 index) public view returns (uint256) {
        uint256 delta = round.stepSize.mul(index);
        return round.minRange.add(delta);
    }

    function getRound() public view returns (VotingRound memory) {
        return round;
    }

    function getReceipt(address voter) public view returns (Receipt memory) {
        return receipts[voter];
    }

    function count() public view returns (uint256 winner) {
        if (round.totalValue == 0) return 0;
        winner = round.totalValue.divideDecimal(round.totalVotes);
    }

    function countAndUpdate(uint256 currentTimestamp) public override returns (uint256 winner) {
        require(msg.sender == address(fund), "only fund");
        winner = count();

        delete voteDistribution;
        delete weightedVoteDistribution;

        round = VotingRound({
            startTimestamp: block.timestamp,
            endTimestamp: currentTimestamp,
            minRange: 0,
            stepSize: STEP_SIZE,
            totalVotes: 0,
            totalValue: 0,
            optionNumber: OPTION_NUMBER
        });

        emit RoundCreated(
            msg.sender,
            round.startTimestamp,
            round.endTimestamp,
            "Schedule weekly rounds for interest rate adjustments"
        );
    }

    function castVote(uint256 support) public {
        _castVote(msg.sender, support);
    }

    function castVoteBySig(
        uint256 support,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public {
        bytes32 domainSeparator =
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), getChainID(), address(this))
            );
        bytes32 structHash = keccak256(abi.encode(BALLOT_TYPEHASH, support));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address signatory = ecrecover(digest, v, r, s);
        require(signatory != address(0), "Governance::castVoteBySig: invalid signature");
        _castVote(signatory, support);
    }

    function _castVote(address voter, uint256 support) internal {
        Receipt storage receipt = receipts[voter];
        require(support < round.optionNumber, "Governance::_castVote: invalid option");
        require(
            receipt.lastVotedTime < round.endTimestamp,
            "Governance::_castVote: voter already voted"
        );

        uint256 votes = votingEscrow.balanceOfAtTimestamp(voter, round.endTimestamp);
        voteDistribution[support] = voteDistribution[support].add(votes);
        round.totalVotes = round.totalVotes.add(votes);

        uint256 option = getOption(support);
        option = option.multiplyDecimal(votes);

        weightedVoteDistribution[support] = weightedVoteDistribution[support].add(option);
        round.totalValue = round.totalValue.add(option);

        receipt.lastVotedTime = round.endTimestamp;
        receipt.support = support;
        receipt.votes = votes;

        emit VoteCast(voter, support, votes);
    }

    function getChainID() internal pure returns (uint256) {
        uint256 chainID;
        assembly {
            chainID := chainid()
        }
        return chainID;
    }
}
