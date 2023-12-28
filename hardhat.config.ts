import type { HardhatUserConfig, NetworksUserConfig } from "hardhat/types";
import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-etherscan";
import "solidity-coverage";
import "./tasks/accounts";
import "./tasks/deploy_address_whitelist";
import "./tasks/deploy_chess_pool";
import "./tasks/deploy_bsc_apr_oracle";
import "./tasks/deploy_bsc_staking_strategy";
import "./tasks/deploy_chess_controller_impl";
import "./tasks/deploy_chess_schedule_impl";
import "./tasks/deploy_chess_schedule_relayer";
import "./tasks/deploy_controller_ballot";
import "./tasks/deploy_eth_staking_strategy";
import "./tasks/deploy_fee_distributor";
import "./tasks/deploy_fund";
import "./tasks/deploy_fund_eth";
import "./tasks/deploy_fund_wsteth";
import "./tasks/deploy_governance";
import "./tasks/deploy_liquidity_gauge_curve";
import "./tasks/deploy_misc";
import "./tasks/deploy_mock";
import "./tasks/deploy_mock_twap_oracle";
import "./tasks/deploy_vesting";
import "./tasks/deploy_voting_escrow_impl";
import "./tasks/deploy_stable_swap";
import "./tasks/deploy_stable_swap_wsteth";
import "./tasks/deploy_sub_governance";
import "./tasks/deploy_swap_router";
import "./tasks/deploy_flash_swap_router";
import "./tasks/deploy_data_aggregator";
import "./tasks/dev_deploy_lz";
import "./tasks/dev_deploy_curve";
import "./tasks/dev_deploy_deposit_contract";
import "./tasks/dev_deploy_token_hub";
import "./tasks/dev_redemption_nft_metadata";
import "./tasks/test_deploy";
import { ETH_RPC, ETH_CHAIN_ID, DEPLOYER_PK, DEPLOYER_HD_PATH, ETHERSCAN_API_KEY } from "./config";
import "hardhat-gas-reporter";

const networks: NetworksUserConfig = {
    hardhat: {
        // Waffle's `changeEtherBalance` does not support the London hard fork yet.
        // See this issue for details: https://github.com/EthWorks/Waffle/issues/571
        hardfork: "berlin",
    },
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
