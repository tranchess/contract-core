import type { HardhatUserConfig, NetworksUserConfig } from "hardhat/types";
import "@nomiclabs/hardhat-waffle";
import "solidity-coverage";
import "./tasks/accounts";
import "./tasks/deploy";
import "./tasks/initialize_fund";
import "./tasks/initialize_timelock";
import {
    TEST_DEPLOYER_PK,
    TEST_ETH_RPC,
    TEST_ETH_CHAIN_ID,
    STAGING_DEPLOYER_PK,
    STAGING_ETH_RPC,
    STAGING_ETH_CHAIN_ID,
} from "./config";
import "hardhat-gas-reporter";

const networks: NetworksUserConfig = {
    hardhat: {},
    localhost: {},
};
if (TEST_DEPLOYER_PK && TEST_ETH_RPC && TEST_ETH_CHAIN_ID) {
    networks.test = {
        url: TEST_ETH_RPC,
        chainId: parseInt(TEST_ETH_CHAIN_ID),
        accounts: [TEST_DEPLOYER_PK],
        timeout: 1000000,
    };
}
if (STAGING_DEPLOYER_PK && STAGING_ETH_RPC && STAGING_ETH_CHAIN_ID) {
    networks.staging = {
        url: STAGING_ETH_RPC,
        chainId: parseInt(STAGING_ETH_CHAIN_ID),
        accounts: [STAGING_DEPLOYER_PK],
        timeout: 1000000,
    };
}

const config: HardhatUserConfig = {
    networks: networks,
    solidity: {
        version: "0.6.12",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
        },
    },
    // @see https://hardhat.org/plugins/hardhat-gas-reporter.html
    gasReporter: {
        enabled: process.env.REPORT_GAS ? true : false,
        excludeContracts: ["test/", "utils/", "misc/"],
    },
};
export default config;
