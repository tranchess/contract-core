// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interfaces/IVotingEscrow.sol";

/// @title Tranchess's Exchange Role Contract
/// @notice Exchange role management
/// @author Tranchess
abstract contract ExchangeRoles {
    event MakerApplied(address indexed account, uint256 expiration);

    /// @notice Voting Escrow.
    IVotingEscrow public immutable votingEscrow;

    /// @notice Minimum vote-locked governance token balance required to place maker orders.
    uint256 public immutable makerRequirement;

    /// @dev Mapping of account => maker expiration timestamp
    mapping(address => uint256) internal _makerExpiration;

    constructor(address votingEscrow_, uint256 makerRequirement_) public {
        votingEscrow = IVotingEscrow(votingEscrow_);
        makerRequirement = makerRequirement_;
    }

    // ------------------------------ MAKER ------------------------------------
    /// @notice Functions with this modifer can only be invoked by makers
    modifier onlyMaker() {
        require(isMaker(msg.sender), "Only maker");
        _;
    }

    /// @notice Returns maker expiration timestamp of an account.
    ///         When `makerRequirement` is zero, this function always returns
    ///         an extremely large timestamp (2500-01-01 00:00:00 UTC).
    function makerExpiration(address account) external view returns (uint256) {
        return makerRequirement > 0 ? _makerExpiration[account] : 16725225600;
    }

    /// @notice Verify if the account is an active maker or not
    /// @param account Account address to verify
    /// @return True if the account is an active maker; else returns false
    function isMaker(address account) public view returns (bool) {
        return makerRequirement == 0 || _makerExpiration[account] > block.timestamp;
    }

    /// @notice Apply for maker membership
    function applyForMaker() external {
        require(makerRequirement > 0, "No need to apply for maker");
        // The membership will be valid until the current vote-locked governance
        // token balance drop below the requirement.
        uint256 expiration = votingEscrow.getTimestampDropBelow(msg.sender, makerRequirement);
        _makerExpiration[msg.sender] = expiration;
        emit MakerApplied(msg.sender, expiration);
    }
}
