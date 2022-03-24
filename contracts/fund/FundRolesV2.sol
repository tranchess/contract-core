// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "../interfaces/ITrancheIndex.sol";

abstract contract FundRolesV2 is ITrancheIndex {
    event PrimaryMarketUpdateProposed(
        address indexed newPrimaryMarket,
        uint256 minTimestamp,
        uint256 maxTimestamp
    );
    event PrimaryMarketUpdated(
        address indexed previousPrimaryMarket,
        address indexed newPrimaryMarket
    );
    event StrategyUpdateProposed(
        address indexed newStrategy,
        uint256 minTimestamp,
        uint256 maxTimestamp
    );
    event StrategyUpdated(address indexed previousStrategy, address indexed newStrategy);

    uint256 private constant ROLE_UPDATE_MIN_DELAY = 3 days;
    uint256 private constant ROLE_UPDATE_MAX_DELAY = 15 days;

    address internal immutable _tokenM;
    address internal immutable _tokenA;
    address internal immutable _tokenB;

    address public primaryMarket;
    address public proposedPrimaryMarket;
    uint256 public proposedPrimaryMarketTimestamp;

    address public strategy;
    address public proposedStrategy;
    uint256 public proposedStrategyTimestamp;

    constructor(
        address tokenM_,
        address tokenA_,
        address tokenB_,
        address primaryMarket_,
        address strategy_
    ) public {
        _tokenM = tokenM_;
        _tokenA = tokenA_;
        _tokenB = tokenB_;
        primaryMarket = primaryMarket_;
        strategy = strategy_;
        emit PrimaryMarketUpdated(address(0), primaryMarket_);
        emit StrategyUpdated(address(0), strategy_);
    }

    modifier onlyShare() {
        require(
            msg.sender == _tokenM || msg.sender == _tokenA || msg.sender == _tokenB,
            "Only share"
        );
        _;
    }

    modifier onlyPrimaryMarket() {
        require(msg.sender == primaryMarket, "Only primary market");
        _;
    }

    function _proposePrimaryMarketUpdate(address newPrimaryMarket) internal {
        require(newPrimaryMarket != primaryMarket);
        proposedPrimaryMarket = newPrimaryMarket;
        proposedPrimaryMarketTimestamp = block.timestamp;
        emit PrimaryMarketUpdateProposed(
            newPrimaryMarket,
            block.timestamp + ROLE_UPDATE_MIN_DELAY,
            block.timestamp + ROLE_UPDATE_MAX_DELAY
        );
    }

    function _applyPrimaryMarketUpdate(address newPrimaryMarket) internal {
        require(proposedPrimaryMarket == newPrimaryMarket, "Proposed address mismatch");
        require(
            block.timestamp >= proposedPrimaryMarketTimestamp + ROLE_UPDATE_MIN_DELAY &&
                block.timestamp < proposedPrimaryMarketTimestamp + ROLE_UPDATE_MAX_DELAY,
            "Not ready to update"
        );
        emit PrimaryMarketUpdated(primaryMarket, newPrimaryMarket);
        primaryMarket = newPrimaryMarket;
        proposedPrimaryMarket = address(0);
        proposedPrimaryMarketTimestamp = 0;
    }

    modifier onlyStrategy() {
        require(msg.sender == strategy, "Only strategy");
        _;
    }

    function _proposeStrategyUpdate(address newStrategy) internal {
        require(newStrategy != strategy);
        proposedStrategy = newStrategy;
        proposedStrategyTimestamp = block.timestamp;
        emit StrategyUpdateProposed(
            newStrategy,
            block.timestamp + ROLE_UPDATE_MIN_DELAY,
            block.timestamp + ROLE_UPDATE_MAX_DELAY
        );
    }

    function _applyStrategyUpdate(address newStrategy) internal {
        require(proposedStrategy == newStrategy, "Proposed address mismatch");
        require(
            block.timestamp >= proposedStrategyTimestamp + ROLE_UPDATE_MIN_DELAY &&
                block.timestamp < proposedStrategyTimestamp + ROLE_UPDATE_MAX_DELAY,
            "Not ready to update"
        );
        emit StrategyUpdated(strategy, newStrategy);
        strategy = newStrategy;
        proposedStrategy = address(0);
        proposedStrategyTimestamp = 0;
    }
}
