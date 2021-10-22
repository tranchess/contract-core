import * as dotenv from "dotenv";
dotenv.config();

export function endOfWeek(timestamp: number): number {
    const WEEK = 86400 * 7;
    const SETTLEMENT_TIME = 3600 * 14;
    return Math.floor((timestamp + WEEK - SETTLEMENT_TIME) / WEEK) * WEEK + SETTLEMENT_TIME;
}

const COINBASE_ADDRESS = "0xfCEAdAFab14d46e20144F48824d0C09B1a03F2BC";
const OKEX_ADDRESS = "0x85615B076615317C80F14cBad6501eec031cD51C";

export const ETH_RPC = process.env.ETH_RPC;
export const ETH_CHAIN_ID = parseInt(process.env.ETH_CHAIN_ID ?? "");
export const DEPLOYER_PK = process.env.DEPLOYER_PK;
export const DEPLOYER_HD_PATH = process.env.DEPLOYER_HD_PATH;

export const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

export const TWAP_ORACLE_CONFIG = {
    PRIMARY_SOURCE: process.env.TWAP_ORACLE_PRIMARY_SOURCE || COINBASE_ADDRESS,
    SECONDARY_SOURCE: process.env.TWAP_ORACLE_SECONDARY_SOURCE || OKEX_ADDRESS,
};

export const GOVERNANCE_CONFIG = {
    CHESS_TOTAL_SUPPLY: "300000000",
    CHESS_SCHEDULE_MAX_SUPPLY: "120000000",
    TREASURY: process.env.GOVERNANCE_TREASURY,
    TIMELOCK_DELAY: parseInt(process.env.GOVERNANCE_TIMELOCK_DELAY ?? "3600"),
    LAUNCH_TIMESTAMP: endOfWeek(
        new Date(process.env.GOVERNANCE_LAUNCH_DATE ?? "1970-01-01").getTime() / 1000
    ),
};

export const FUND_CONFIG = {
    MIN_CREATION: process.env.FUND_MIN_CREATION ?? "",
    GUARDED_LAUNCH: process.env.FUND_GUARDED_LAUNCH === "TRUE",
};

export const EXCHANGE_CONFIG = {
    MIN_ORDER_AMOUNT: process.env.EXCHANGE_MIN_ORDER_AMOUNT ?? "",
    GUARDED_LAUNCH_MIN_ORDER_AMOUNT: process.env.EXCHANGE_GUARDED_LAUNCH_MIN_ORDER_AMOUNT ?? "",
    MAKER_REQUIREMENT: process.env.EXCHANGE_MAKER_REQUIREMENT ?? "",
};
