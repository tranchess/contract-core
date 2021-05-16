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

### Configuration

Copy the file `.env.example` to `.env` and modify configurations in the file.

This project depends on a few external contracts. On a public blockchain, please update
their addresses in `.env`. On a private blockchain, deploy mocking contracts using the following
command.

`npx hardhat deploy_mock --network remote`

### Oracle Contracts

`npx hardhat deploy_oracle --network remote`

On a private blockchain, you may want to use mocked oracles.

### Governance Contracts

`npx hardhat deploy_governance --network remote`

### Fund Contracts

`npx hardhat deploy_fund --network remote`

### Exchange Contracts

`npx hardhat deploy_exchange --network remote`

Exchange depends on governance and fund contracts. The above command reads address of
these contracts from address files, which are created in the `deploy` directory when
those contracts are created. You can select the address files interactively, or use
command line arguments `--governance <file>` and `--fund <file>` to specify them,
where `<file>` can be either `latest` or relative path to a concrete file (e.g.
`deploy/fund_address_XXX.json`).

### Initialize the Fund

`npx hardhat initialize_fund --network remote`

Like `deploy_exchange`, this command also needs governance and fund contract addresses.
