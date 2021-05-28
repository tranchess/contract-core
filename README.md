# Tranchess Core

Tranchess core.

# Local Development

## Install Dependencies

`npm install`

## Compile Contracts

`npx hardhat compile`

## Run Tests

`npm run test`

## Check Lint and Format

`npm run check`

## Deploy Contracts

### Deployed Contract Address

Each of the following deployment tasks creates a JSON file under the `deploy` directory,
writing address of all deployed contracts in it. Some tasks need to read address files
created by other tasks, in which case you can choose address files interactively, or use
command line arguments `--<module> <file>` to specify them, where `<module>` is the suffix
of a task name (e.g. `governance` or `fund`) and `<file>` can be either `latest` or
relative path to a concrete file (e.g. `deploy/fund_address_XXX.json`).

### Configuration

Copy the file `.env.example` to `.env` and modify configurations in the file.

This project depends on a few external contracts. On a public blockchain, please update
their addresses in `.env`. On a private blockchain, deploy mock contracts using the following
command.

`npx hardhat deploy_mock --network remote`

### Oracle Contracts

`npx hardhat deploy_oracle --network remote`

On a private blockchain, you may want to use mock oracles instead of contracts deployed
by this task.

### Governance Contracts

`npx hardhat deploy_governance --network remote`

### Fund Contracts

`npx hardhat deploy_fund --network remote`

It needs governance contract addresses. Use the optional argument `--governance <file>`
to specify an address file.

### Exchange Contracts

`npx hardhat deploy_exchange --network remote`

It needs governance and fund contract addresses. Use the optional arguments `--governance <file>`
and `--fund <file>` to specify address files.

### Test the Deployment Tasks

The Hardhat task `test_deploy` runs all the above deployment tasks on a temporary local
Hardhat network. It can be used as a preliminary test.

`npx hardhat test_deploy`
