# Terminology

This document defines terminologies and abbreviations used in smart contracts.

## Fund

-   **Underlying**: assets invested in the fund to create fund shares.
-   **Share**: a unit of a tranche token, or a tranche token smart contract.
-   **Tranche**: integer representation of a tranche, 0 for QUEEN, 1 for BISHOP, 2 for ROOK.
-   **Net Asset Value** (abbr. **NAV**): fair value of a share, which is calculated from a 30-minute
    TWAP of the underlying assets.
-   **Protocol Fee**: a daily fee charged from a fund by the Tranchess protocol.
-   **Interest Rate**: the stable interest rate that ROOK holders pay BISHOP holders.
    It is realized by a daily increment on BISHOP's NAV.
-   **Settle** (in fund): the action to finish a trading day and start the next, including charging
    protocol fee, completing creations and redemptions and calculating NAV of the three tranches.
-   **Trading Day**: interval of settlements. A _trading day_ starts at UTC time 14:00 of a day
    (inclusive) and ends at the same time of the next day (exclusive).
-   **Trading Week**: interval of interest rate update. A _trading week_ consists of 7 continuous
    trading days and starts at UTC time 14:00 of a Thursday.
-   **Rebalance**: a linear transformation of the three tranche tokens' balance in order to
    maintain a stable leverage rate. In smart contracts, _rebalance_ also refers to the concrete
    transformation matrix.
-   **Version** (of a tranche token balance): the number of rebalances that the tranche token
    balance has been transformed. Rebalance is performed lazily in smart contracts. If the version
    of a stored tranche token balance is smaller than the total number of rebalances in the past,
    the token balance should be transformed beyond the latest rebalance before it can be used
    or returned to users.
-   **Active**: whether various actions can be taken. In case of a rebalance or a potential
    rebalance, some actions are temporarily disabled due to safety considerations. These actions
    include:
    -   tranche token transfer
    -   actions in the primary market
    -   placing a taker order in the exchange

## Primary Market

-   **Create**: the action to invest underlying assets in a fund and mint QUEEN.
-   **Redeem**: the action to burn QUEEN and get underlying assets back from a fund.
-   **Split**: the action to burn QUEEN and mint BISHOP and ROOK according to tranche weights.
-   **Merge**: the action to burn BISHOP and ROOK and mint QUEEN according to tranche weights.
