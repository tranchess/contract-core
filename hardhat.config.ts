import type { HardhatUserConfig, NetworksUserConfig } from "hardhat/types";
import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-etherscan";
import "solidity-coverage";
import "./tasks/accounts";
import "./tasks/deploy_fund";
import "./tasks/deploy_exchange";
import "./tasks/deploy_governance";
import "./tasks/deploy_misc";
import "./tasks/deploy_mock";
import "./tasks/deploy_oracle";
import "./tasks/deploy_vesting";
import "./tasks/test_deploy";
import { ETH_RPC, ETH_CHAIN_ID, DEPLOYER_PK, DEPLOYER_HD_PATH, ETHERSCAN_API_KEY } from "./config";
import "hardhat-gas-reporter";

const networks: NetworksUserConfig = {
    hardhat: {},
    localhost: {},
};
if (ETH_RPC && ETH_CHAIN_ID) {
    if (!DEPLOYER_PK && !DEPLOYER_HD_PATH) {
        throw new Error("Please set either DEPLOYER_PK or DEPLOYER_HD_PATH for the remote network");
    }
    if (DEPLOYER_PK && DEPLOYER_HD_PATH) {
        throw new Error("Do not set both DEPLOYER_PK and DEPLOYER_HD_PATH");
    }
    networks.remote = {
        url: ETH_RPC,
        chainId: ETH_CHAIN_ID,
        accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
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
    etherscan: {
        apiKey: ETHERSCAN_API_KEY,
    },
    // @see https://hardhat.org/plugins/hardhat-gas-reporter.html
    gasReporter: {
        enabled: process.env.REPORT_GAS ? true : false,
        excludeContracts: ["test/", "utils/", "misc/"],
    },
};
export default config;
