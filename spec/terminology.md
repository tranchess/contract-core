# Terminology

This document defines terminologies and abbreviations used in smart contracts.

## Fund

-   **Underlying**: assets invested in the fund to create fund shares.
-   **Token M/A/B**: ERC-20 token of Tranche M/A/B.
-   **Share**: a unit of a tranche token, or a tranche token smart contract.
-   **Tranche**: integer representation of a tranche, 0 for M, 1 for A, 2 for B.
-   **Tranche Weight**: weight of the three tranches in splitting and merging. For example,
    M:A:B = 3:1:2 indicates that each token M can be split into 1/3 token A and 2/3 token B.
-   **Net Asset Value** (abbr. **NAV**): fair value of a share, which is calculated from a 30-minute
    TWAP of the underlying assets.
-   **Protocol Fee**: a daily fee charged from a fund by the Tranchess protocol.
-   **Interest Rate**: the stable interest rate that Tranche B holders pay Tranche A holders.
    It is realized by a daily increment on Tranche A's NAV.
-   **Settle** (in fund): the action to finish a trading day and start the next, including charging
    protocol fee, completing creations and redemptions and calculating NAV of the three tranches.
-   **Trading Day**: interval of settlements. A _trading day_ starts at UTC time 14:00 of a day
    (inclusive) and ends at the same time of the next day (exclusive).
-   **Trading Week**: interval of interest rate update. A _trading week_ consists of 7 continuous
    trading days and starts at UTC time 14:00 of a Thursday.
-   **Rebalance**: a linear transformation of the three tranche tokens' balance in order to
    maintain a stable leverage rate. In smart contracts, _rebalance_ also refers to the concrete
    transformation matrix.
-   **Upper/Lower Threshold M/A/B**: a condition to trigger a rebalance. For example, rebalance is
    triggered when NAV of Tranche A is higher than _upper threshold A_.
-   **Version** (of a tranche token balance): the number of rebalances that the tranche token
    balance has been transformed. Rebalance is performed lazily in smart contracts. If the version
    of a stored tranche token balance is smaller than the total number of rebalances in the past,
    the token balance should be transformed beyond the latest rebalance before it can be used
    or returned to users.
-   **Total Shares**: the total number of shares of a fund, which equals to the total supply of
    Token M if there's no Token A and B. When tranche weights M:A:B = 2:1:1, total shares of a fund
    is just the sum of total supply of all the three tranche tokens.
-   **Active**: whether various actions can be taken. In case of a rebalance or a potential
    rebalance, some actions are temporarily disabled due to safety considerations. These actions
    include:
    -   tranche token transfer
    -   actions in the primary market
    -   placing a taker order in the exchange

## Primary Market

-   **Create**: the action to invest underlying assets in a fund and mint token M.
-   **Redeem**: the action to burn token M and get underlying assets back from a fund.
-   **Split**: the action to burn token M and mint token A and B according to tranche weights.
-   **Merge**: the action to burn token A and B and mint M according to tranche weights.

## Exchange

-   **Quote Asset**: the quote currency token in all trading pairs in the exchange contract,
    usually a stablecoin.
-   **Base Asset**: base currency token in a trading pair, i.e. token M, A or B.
-   **Epoch**: a 30-minute period. Trades in the same epoch use the same estimated price for matching
    (NAV in the epoch before the previous epoch) and the same reference price (NAV in the next epoch).
-   **Maker**: user that places a post-only order, which stays in the order book until matched
    with a taker order.
-   **Taker**: user that places a fill-and-kill order, which immediately matches maker orders
    in the order book.
-   **Premium-Discount Level** (abbr. **PD Level**): integer representation of a premium-discount
    value, starting from 1 for -10% to 81 for +10%.
-   **Unsettled Trade**: accumulative result of all matched trades in a single epoch. For example,
    when a taker buy order is matched with a maker sell order, the result of this matching is
    added to both the taker's unsettled buy trade and the maker's unsettled sell trade in this epoch.
-   **Settle** (in exchange): the action to calculate and claim the outcome of an unsettled trade
    according to its reference price (in the next epoch). When an unsettled trade is settled by
    a user, shares are added to the user's available balance in the exchange, while quote assets
    are transfered to the user's address directly.
-   **Reward**: CHESS token rewarded for staking shares in the exchange contract.
-   **Reward Weight**: weight of the three tranches in calculating rewards.
