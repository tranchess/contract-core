import type { HardhatUserConfig, NetworksUserConfig } from "hardhat/types";
import "@nomiclabs/hardhat-waffle";
import "solidity-coverage";
import "./tasks/accounts";
import "./tasks/deploy_fund";
import "./tasks/deploy_exchange";
import "./tasks/deploy_governance";
import "./tasks/deploy_misc";
import "./tasks/deploy_mock";
import "./tasks/deploy_oracle";
import "./tasks/test_deploy";
import { DEPLOYER_PK, ETH_RPC, ETH_CHAIN_ID } from "./config";
import "hardhat-gas-reporter";

const networks: NetworksUserConfig = {
    hardhat: {},
    localhost: {},
};
if (DEPLOYER_PK && ETH_RPC && ETH_CHAIN_ID) {
    networks.remote = {
        url: ETH_RPC,
        chainId: ETH_CHAIN_ID,
        accounts: [DEPLOYER_PK],
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
