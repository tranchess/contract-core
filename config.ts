import * as dotenv from "dotenv";
dotenv.config();

const DAY = 86400;
const WEEK = DAY * 7;
export function endOfWeek(timestamp: number): number {
    const SETTLEMENT_TIME = 3600 * 14;
    return Math.floor((timestamp + WEEK - SETTLEMENT_TIME) / WEEK) * WEEK + SETTLEMENT_TIME;
}

const COINBASE_ADDRESS = "0xfCEAdAFab14d46e20144F48824d0C09B1a03F2BC";
const OKEX_ADDRESS = "0x85615B076615317C80F14cBad6501eec031cD51C";

export const DEPLOYER_PK = process.env.DEPLOYER_PK;
export const ETH_RPC = process.env.ETH_RPC;
export const ETH_CHAIN_ID = parseInt(process.env.ETH_CHAIN_ID ?? "");

export const TWAP_ORACLE_CONFIG = {
    SYMBOL: "BTC",
    PRIMARY_SOURCE: process.env.TWAP_ORACLE_PRIMARY_SOURCE || COINBASE_ADDRESS,
    SECONDARY_SOURCE: process.env.TWAP_ORACLE_SECONDARY_SOURCE || OKEX_ADDRESS,
};

// export const BSC_MAINNET_VUSDC_ADDRESS = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8";
// export const BSC_TESTNET_VUSDC_ADDRESS = "0xD5C4C2e2facBEB59D0216D0595d63FcDc6F9A1a7";
export const APR_ORACLE_CONFIG = {
    V_TOKEN: process.env.APR_ORACLE_V_TOKEN ?? "",
};

export const GOVERNANCE_CONFIG = {
    TIMELOCK_DELAY: parseInt(process.env.GOVERNANCE_TIMELOCK_DELAY ?? "3600"),
    LAUNCH_TIMESTAMP: endOfWeek(
        new Date(process.env.GOVERNANCE_LAUNCH_DATE ?? "1970-01-01").getTime() / 1000
    ),
};

export const LAUNCH_CAP_END_TIME = GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP + 4 * WEEK ?? "";

export const FUND_CONFIG = {
    UNDERLYING_ADDRESS: process.env.FUND_UNDERLYING_ADDRESS ?? "",
    TWAP_ORACLE_ADDRESS: process.env.FUND_TWAP_ORACLE_ADDRESS ?? "",
    APR_ORACLE_ADDRESS: process.env.FUND_APR_ORACLE_ADDRESS ?? "",
    MIN_CREATION: process.env.FUND_MIN_CREATION ?? "",
    SPLIT_START_TIME: GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP + 2 * WEEK ?? "",
};

export const EXCHANGE_CONFIG = {
    QUOTE_ADDRESS: process.env.EXCHANGE_QUOTE_ADDRESS ?? "",
    INITIAL_MIN_ORDER_AMOUNT: process.env.EXCHANGE_MIN_ORDER_AMOUNT ?? "2000",
    MIN_ORDER_AMOUNT: process.env.EXCHANGE_MIN_ORDER_AMOUNT ?? "50000",
    MAKER_REQUIREMENT: process.env.EXCHANGE_MAKER_REQUIREMENT ?? "",
    ORDER_PLACING_START_TIME: GOVERNANCE_CONFIG.LAUNCH_TIMESTAMP + 2 * WEEK + 2 * DAY ?? "",
};
