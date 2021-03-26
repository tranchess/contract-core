// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./ITwapOracle.sol";

interface IFund {
    /// @notice A linear transformation matrix that represents a conversion.
    ///
    ///         ```
    ///             [ ratioP          0        0 ]
    ///         C = [ ratioA2P  ratioAB        0 ]
    ///             [ ratioB2P        0  ratioAB ]
    ///         ```
    ///
    ///         Amounts of the three shares `p`, `a` and `b` can be converted by multiplying the matrix:
    ///
    ///         ```
    ///         [ p', a', b' ] = [ p, a, b ] * C
    ///         ```
    struct Conversion {
        uint256 ratioP;
        uint256 ratioA2P;
        uint256 ratioB2P;
        uint256 ratioAB;
        uint256 day;
    }

    function splitWeights() external pure returns (uint256 weightA, uint256 weightB);

    function tokenUnderlying() external view returns (address);

    function tokenP() external view returns (address);

    function tokenA() external view returns (address);

    function tokenB() external view returns (address);

    function underlyingDecimalMultiplier() external view returns (uint256);

    function twapOracle() external view returns (ITwapOracle);

    function governance() external view returns (address);

    function endOfDay(uint256 timestamp) external pure returns (uint256);

    function endOfWeek(uint256 timestamp) external pure returns (uint256);

    function shareTotalSupply(uint256 tranche) external view returns (uint256);

    function shareBalanceOf(uint256 tranche, address account) external view returns (uint256);

    function shareBalanceVersion(address account) external view returns (uint256);

    function shareAllowance(
        uint256 tranche,
        address owner,
        address spender
    ) external view returns (uint256);

    function shareAllowanceVersion(address owner, address spender) external view returns (uint256);

    function getConversionSize() external view returns (uint256);

    function getConversion(uint256 index) external view returns (Conversion memory);

    function getConversionTimestamp(uint256 index) external view returns (uint256);

    function currentDay() external view returns (uint256);

    function marketActivityStartTime() external view returns (uint256);

    function exchangeActivityStartTime() external view returns (uint256);

    function isPrimaryMarketActive(address primaryMarket, uint256 timestamp)
        external
        view
        returns (bool);

    function isExchangeActive(uint256 timestamp) external view returns (bool);

    function getTotalShares() external view returns (uint256);

    function extrapolateNav(uint256 timestamp, uint256 price)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        );

    function extrapolateNavP(uint256 timestamp, uint256 price) external view returns (uint256);

    function extrapolateNavA(uint256 timestamp) external view returns (uint256);

    function calculateNavB(uint256 navP, uint256 navA) external pure returns (uint256);

    function convert(
        uint256 amountP,
        uint256 amountA,
        uint256 amountB,
        uint256 index
    )
        external
        view
        returns (
            uint256 newAmountP,
            uint256 newAmountA,
            uint256 newAmountB
        );

    function batchConvert(
        uint256 amountP,
        uint256 amountA,
        uint256 amountB,
        uint256 fromIndex,
        uint256 toIndex
    )
        external
        view
        returns (
            uint256 newAmountP,
            uint256 newAmountA,
            uint256 newAmountB
        );

    function refreshBalance(address account, uint256 targetVersion) external;

    function refreshAllowance(
        address owner,
        address spender,
        uint256 targetVersion
    ) external;

    function mint(
        uint256 tranche,
        address account,
        uint256 amount
    ) external;

    function burn(
        uint256 tranche,
        address account,
        uint256 amount
    ) external;

    function transfer(
        uint256 tranche,
        address sender,
        address recipient,
        uint256 amount
    ) external;

    function approve(
        uint256 tranche,
        address owner,
        address spender,
        uint256 amount
    ) external;

    event ConversionTriggered(
        uint256 indexed index,
        uint256 indexed day,
        uint256 ratioP,
        uint256 ratioA2P,
        uint256 ratioB2P,
        uint256 ratioAB
    );
    event Settled(uint256 indexed day, uint256 navP, uint256 navA, uint256 navB);
}
