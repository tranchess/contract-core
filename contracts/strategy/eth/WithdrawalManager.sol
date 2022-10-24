// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";

import "../../interfaces/IWrappedERC20.sol";
import "./IWithdrawalManager.sol";
import "./EthStakingStrategy.sol";

contract WithdrawalManager is IWithdrawalManager, Initializable {
    event EtherReceived(address indexed from, uint256 amount, uint256 time);

    EthStakingStrategy public immutable strategy;
    IWrappedERC20 private immutable _tokenUnderlying;

    uint256 public operatorID;

    constructor(address payable strategy_) public {
        strategy = EthStakingStrategy(strategy_);
        _tokenUnderlying = IWrappedERC20(
            IFundV3(EthStakingStrategy(strategy_).fund()).tokenUnderlying()
        );
    }

    function initialize(uint256 operatorID_) external initializer {
        operatorID = operatorID_;
    }

    receive() external payable {
        emit EtherReceived(msg.sender, msg.value, block.timestamp);
    }

    function getWithdrawalCredential() external view override returns (bytes32) {
        return bytes32(uint256(address(payable(this))) | (1 << 248));
    }

    function transferToStrategy(uint256 amount) external override onlyStrategy {
        (bool success, ) = address(strategy).call{value: amount}("");
        require(success);
    }

    modifier onlyStrategy() {
        require(address(strategy) == msg.sender, "Only strategy");
        _;
    }
}
