// SPDX-License-Identifier: MIT
pragma solidity >=0.6.10 <0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";

import "../../utils/SafeDecimalMath.sol";
import "../../utils/CoreUtility.sol";
import "../interfaces/IFundV2.sol";
import "../../fund/FundV3.sol";
import "../../fund/ShareStaking.sol";
import "../interfaces/IPrimaryMarketV2.sol";
import "../../interfaces/ITwapOracle.sol";
import "../../interfaces/IAprOracle.sol";
import "../../interfaces/IBallot.sol";
import "../interfaces/ITrancheIndex.sol";

interface IOldExchange {
    function protocolUpgrade(address account)
        external
        returns (
            uint256 amountM,
            uint256 amountA,
            uint256 amountB,
            uint256 claimedRewards
        );
}

interface IDailyProtocolFeeRate {
    function dailyProtocolFeeRate() external view returns (uint256);
}

/// @notice This is the core contract for the upgrade to Tranchess V2. It replaces the following
///         contracts of the Tranchess protocol during the upgrade process:
///
///         * TwapOracle of the old Fund
///         * PrimaryMarket of the old Fund
///         * PrimaryMarket of the new Fund
/// @dev The upgrade procedure consists of the following stages:
///
///      *STAGE_START*. The owner of the old Fund changes both primary market and TWAP oracle
///      to this contract. As a primary market, it records the old tranche tokens' total supplies
///      and asks the old Fund to transfer all underlying tokens but one unit to this contract when
///      the old Fund settles. As a TWAP oracle, it returns a special value to ensure the total value
///      of the old Fund does not change after almost all underlying tokens are transferred out,
///      so that no rebalance is triggered.
///
///      * Change Fund's primary market to this contract
contract UpgradeTool is
    ITwapOracle,
    IAprOracle,
    IBallot,
    IPrimaryMarketV2,
    ITrancheIndex,
    CoreUtility,
    Ownable
{
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;
    using SafeERC20 for IERC20;

    event Upgraded(
        address account,
        uint256 oldM,
        uint256 oldA,
        uint256 oldB,
        uint256 newM,
        uint256 newA,
        uint256 newB,
        uint256 claimedRewards
    );

    uint256 private constant STAGE_START = 0;
    uint256 private constant STAGE_SETTLED = 1;
    uint256 private constant STAGE_UPGRADED = 2;

    IFund public immutable oldFund;
    ITwapOracle public immutable originTwapOracle;
    IERC20 public immutable tokenUnderlying;
    IERC20 public immutable oldTokenM;
    IERC20 public immutable oldTokenA;
    IERC20 public immutable oldTokenB;
    uint256 public immutable oldFundVersion;

    IOldExchange public immutable oldExchange;

    FundV3 public immutable newFund;
    ShareStaking public immutable newStaking;

    uint256 public immutable upgradeTimestamp;

    uint256 public stage;

    /// @notice Total amount of underlying tokens managed by the old Fund right before this upgrade.
    uint256 public upgradeUnderlying;

    /// @notice Initial split ratio of the new Fund.
    uint256 public initialSplitRatio;

    constructor(
        address oldFund_,
        uint256 oldFundVersion_,
        address oldExchange_,
        address newFund_,
        address newStaking_,
        uint256 upgradeTimestamp_
    ) public {
        oldFund = IFund(oldFund_);
        originTwapOracle = ITwapOracle(IFund(oldFund_).twapOracle());
        tokenUnderlying = IERC20(IFund(oldFund_).tokenUnderlying());
        oldTokenM = IERC20(IFund(oldFund_).tokenM());
        oldTokenA = IERC20(IFund(oldFund_).tokenA());
        oldTokenB = IERC20(IFund(oldFund_).tokenB());
        oldFundVersion = oldFundVersion_;

        oldExchange = IOldExchange(oldExchange_);

        newFund = FundV3(newFund_);
        require(IFund(oldFund_).tokenUnderlying() == IFund(newFund_).tokenUnderlying());
        newStaking = ShareStaking(newStaking_);
        require(address(ShareStaking(newStaking_).fund()) == newFund_);

        require(upgradeTimestamp_ + 1 weeks == _endOfWeek(upgradeTimestamp_));
        upgradeTimestamp = upgradeTimestamp_;
    }

    modifier onlyStage(uint256 expectedStage) {
        require(stage == expectedStage, "Incorrect stage");
        _;
    }

    /// @dev This is used by 3rd-party tools to calculate TVL in the SETTLED stage.
    function currentCreatingUnderlying() external view returns (uint256) {
        return
            stage <= STAGE_SETTLED ? upgradeUnderlying : tokenUnderlying.balanceOf(address(this));
    }

    /// @notice As a special TWAP oracle of the old Fund, it returns the same value as the original
    ///         oracle before the protocol upgrade. After the upgrade, it constantly returns the
    ///         total value of the Fund at the time of the upgrade, which keeps NAV of the Fund
    ///         constant forever.
    function getTwap(uint256 timestamp) external view override returns (uint256) {
        if (timestamp < upgradeTimestamp) {
            return originTwapOracle.getTwap(timestamp);
        } else {
            uint256 underlying = upgradeUnderlying;
            if (underlying == 0) {
                // We are in stage STAGE_START and all underlying tokens are still in the old Fund.
                underlying = oldFundVersion == 2
                    ? IFundV2(address(oldFund)).getTotalUnderlying()
                    : tokenUnderlying.balanceOf(address(oldFund));
                uint256 protocolFee =
                    underlying.multiplyDecimal(
                        IDailyProtocolFeeRate(address(oldFund)).dailyProtocolFeeRate()
                    );
                underlying = underlying.sub(protocolFee);
            }
            return originTwapOracle.getTwap(upgradeTimestamp).mul(underlying);
        }
    }

    /// @notice As a special APR oracle of the old Fund, it always returns zero to keep
    ///         Tranche A's NAV unchanged.
    function capture() external override returns (uint256) {
        return 0;
    }

    /// @notice As a special interest rate ballot of the old Fund, it always returns zero to keep
    ///         Tranche A's NAV unchanged.
    function count(uint256) external view override returns (uint256) {
        return 0;
    }

    /// @dev For IBallot.
    function syncWithVotingEscrow(address account) external override {}

    /// @dev For IPrimaryMarketV2.
    function claim(address) external override returns (uint256, uint256) {
        revert("Not allowed");
    }

    /// @dev For IPrimaryMarketV2.
    function claimAndUnwrap(address) external override returns (uint256, uint256) {
        revert("Not allowed");
    }

    /// @dev For IPrimaryMarketV2.
    function updateDelayedRedemptionDay() external override {}

    /// @dev For IPrimaryMarketV3.
    function canBeRemovedFromFund() external view returns (bool) {
        return stage == STAGE_UPGRADED;
    }

    /// @dev For IPrimaryMarketV3.
    function settle(uint256) external {}

    function settle(
        uint256 day,
        uint256, // fundTotalShares
        uint256 fundUnderlying,
        uint256, // underlyingPrice
        uint256 // previousNav
    )
        external
        override
        returns (
            uint256 sharesToMint,
            uint256 sharesToBurn,
            uint256 creationUnderlying,
            uint256 redemptionUnderlying,
            uint256 fee
        )
    {
        require(oldFund.twapOracle() == this, "Not TWAP oracle of the old fund");
        require(msg.sender == address(oldFund), "Only old fund");
        if (day < upgradeTimestamp) {
            return (0, 0, 0, 0, 0);
        }
        if (stage == STAGE_START) {
            upgradeUnderlying = fundUnderlying;
            stage = STAGE_SETTLED;
        }

        // Fetch all but 1 unit of underlying tokens from the Fund. This guarantees that there's
        // only 1 unit of underlying token left in the old Fund at each settlement after the upgrade,
        // so that the NAVs remain the same and no rebalance will be triggered. In case that someone
        // transfers underlying tokens directly to the old Fund, these tokens will be transferred to
        // and forever locked in this contract.
        redemptionUnderlying = fundUnderlying.sub(1);
    }

    /// @notice Transfer all underlying tokens to the new Fund and mint all new tranche tokens.
    ///         When this function is called, this contract should be the primary market of the
    ///         new Fund and the new Fund should be empty.
    function createNewTokens() external onlyOwner onlyStage(STAGE_SETTLED) {
        (, uint256 navA, uint256 navB) = oldFund.historicalNavs(upgradeTimestamp);
        uint256 splitRatio =
            originTwapOracle.getTwap(upgradeTimestamp).divideDecimal(navA.add(navB));
        initialSplitRatio = splitRatio;
        uint256 hotBalance = tokenUnderlying.balanceOf(address(this));
        newFund.initialize(splitRatio, navA, navB, upgradeUnderlying.sub(hotBalance));
        newFund.transferOwnership(owner());

        tokenUnderlying.safeTransfer(address(newFund), hotBalance);
        newFund.primaryMarketMint(
            TRANCHE_M,
            address(this),
            oldFund.shareTotalSupply(TRANCHE_M).divideDecimal(splitRatio.mul(2)),
            0
        );
        newFund.primaryMarketMint(TRANCHE_A, address(this), oldFund.shareTotalSupply(TRANCHE_A), 0);
        newFund.primaryMarketMint(TRANCHE_B, address(this), oldFund.shareTotalSupply(TRANCHE_B), 0);
        stage = STAGE_UPGRADED;
    }

    /// @notice Transfer all underlying tokens back to the old Fund in case of emergency rollback.
    function rollback() external onlyOwner onlyStage(STAGE_SETTLED) {
        tokenUnderlying.safeTransfer(address(oldFund), tokenUnderlying.balanceOf(address(this)));
    }

    /// @notice Transfer the new fund's ownership back to admin in case that `createNewTokens()`
    ///         fails unexpectedly.
    function transferNewFundOwnership() external onlyOwner {
        newFund.transferOwnership(owner());
    }

    function protocolUpgrade(address account)
        external
        onlyStage(STAGE_UPGRADED)
        returns (
            uint256 amountM,
            uint256 amountA,
            uint256 amountB,
            uint256 claimedRewards
        )
    {
        if (Address.isContract(account)) {
            // It is unsafe to upgrade for a smart contract. Such operation is only allowed by
            // the contract itself or the owner.
            require(
                msg.sender == account || msg.sender == owner(),
                "Smart contracts can only be upgraded by itself or admin"
            );
        }

        // Burn unstaked old tokens
        (uint256 oldBalanceM, uint256 oldBalanceA, uint256 oldBalanceB) =
            oldFund.allShareBalanceOf(account);
        if (oldBalanceM > 0) {
            oldFund.burn(TRANCHE_M, account, oldBalanceM);
        }
        if (oldBalanceA > 0) {
            oldFund.burn(TRANCHE_A, account, oldBalanceA);
        }
        if (oldBalanceB > 0) {
            oldFund.burn(TRANCHE_B, account, oldBalanceB);
        }

        // Burn staked old tokens
        {
            uint256 stakedM;
            uint256 stakedA;
            uint256 stakedB;
            (stakedM, stakedA, stakedB, claimedRewards) = oldExchange.protocolUpgrade(account);
            if (stakedM > 0) {
                oldFund.burn(TRANCHE_M, address(oldExchange), stakedM);
                oldBalanceM = oldBalanceM.add(stakedM);
            }
            if (stakedA > 0) {
                oldFund.burn(TRANCHE_A, address(oldExchange), stakedA);
                oldBalanceA = oldBalanceA.add(stakedA);
            }
            if (stakedB > 0) {
                oldFund.burn(TRANCHE_B, address(oldExchange), stakedB);
                oldBalanceB = oldBalanceB.add(stakedB);
            }
        }

        // Mint all collected old tokens so that their total supplies do not change
        if (oldBalanceM > 0) {
            oldFund.mint(TRANCHE_M, address(this), oldBalanceM);
        }
        if (oldBalanceA > 0) {
            oldFund.mint(TRANCHE_A, address(this), oldBalanceA);
        }
        if (oldBalanceB > 0) {
            oldFund.mint(TRANCHE_B, address(this), oldBalanceB);
        }

        uint256 newVersion = newFund.getRebalanceSize();
        amountM = oldBalanceM.divideDecimal(initialSplitRatio.mul(2));
        amountA = oldBalanceA;
        amountB = oldBalanceB;
        if (newVersion > 0) {
            (amountM, amountA, amountB) = newFund.batchRebalance(
                amountM,
                amountA,
                amountB,
                0,
                newVersion
            );
        }

        newFund.trancheTransfer(TRANCHE_M, address(newStaking), amountM, newVersion);
        newStaking.deposit(TRANCHE_M, amountM, account, newVersion);
        newFund.trancheTransfer(TRANCHE_A, address(newStaking), amountA, newVersion);
        newStaking.deposit(TRANCHE_A, amountA, account, newVersion);
        newFund.trancheTransfer(TRANCHE_B, address(newStaking), amountB, newVersion);
        newStaking.deposit(TRANCHE_B, amountB, account, newVersion);

        emit Upgraded(
            account,
            oldBalanceM,
            oldBalanceA,
            oldBalanceB,
            amountM,
            amountA,
            amountB,
            claimedRewards
        );
    }
}
