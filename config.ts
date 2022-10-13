import * as dotenv from "dotenv";
dotenv.config();

export function endOfWeek(timestamp: number): number {
    const WEEK = 86400 * 7;
    const SETTLEMENT_TIME = 3600 * 14;
    return Math.floor((timestamp + WEEK - SETTLEMENT_TIME) / WEEK) * WEEK + SETTLEMENT_TIME;
}

export const ETH_RPC = process.env.ETH_RPC;
export const ETH_CHAIN_ID = parseInt(process.env.ETH_CHAIN_ID ?? "");
export const DEPLOYER_PK = process.env.DEPLOYER_PK;
export const DEPLOYER_HD_PATH = process.env.DEPLOYER_HD_PATH;

export const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

export const GOVERNANCE_CONFIG = {
    CHESS_TOTAL_SUPPLY: "300000000",
    CHESS_SCHEDULE_MAX_SUPPLY: "120000000",
    TREASURY: process.env.GOVERNANCE_TREASURY,
    TIMELOCK_DELAY: parseInt(process.env.GOVERNANCE_TIMELOCK_DELAY ?? "3600"),
    LAUNCH_TIMESTAMP: endOfWeek(
        new Date(process.env.GOVERNANCE_LAUNCH_DATE ?? "1970-01-01").getTime() / 1000
    ),
    ANYSWAP_ROUTER: process.env.ANYSWAP_ROUTER,
    ANY_CALL_PROXY: process.env.ANY_CALL_PROXY,
};
