import * as dotenv from "dotenv";
dotenv.config();

export const TEST_DEPLOYER_PK = process.env.TEST_DEPLOYER_PK;
export const TEST_ETH_RPC = process.env.TEST_ETH_RPC;
export const TEST_ETH_CHAIN_ID = process.env.TEST_ETH_CHAIN_ID;

export const TEST_TWAP_ORACLE = process.env.TEST_TWAP_ORACLE;
export const TEST_APR_ORACLE = process.env.TEST_APR_ORACLE;
export const TEST_WBTC = process.env.TEST_WBTC;
export const TEST_USDC = process.env.TEST_USDC;
export const TEST_MIN_CREATION = process.env.TEST_MIN_CREATION ?? "";

export const STAGING_DEPLOYER_PK = process.env.STAGING_DEPLOYER_PK;
export const STAGING_ETH_RPC = process.env.STAGING_ETH_RPC;
export const STAGING_ETH_CHAIN_ID = process.env.STAGING_ETH_CHAIN_ID;

export const STAGING_TWAP_ORACLE = process.env.STAGING_TWAP_ORACLE;
export const STAGING_APR_ORACLE = process.env.STAGING_APR_ORACLE;
export const STAGING_WBTC = process.env.STAGING_WBTC;
export const STAGING_USDC = process.env.STAGING_USDC;
export const STAGING_MIN_CREATION = process.env.STAGING_MIN_CREATION ?? "";
