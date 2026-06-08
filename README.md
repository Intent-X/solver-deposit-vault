# Solver Deposit Vault

Upgradeable custody vault (`SolverVault`) where users deposit collateral, request
signature-gated withdrawals, and a rebalancer moves idle funds to whitelisted
treasuries. Built with **Hardhat 3** + ethers v6 + OpenZeppelin upgradeable proxies.

## Roles

- **Executor** – accepts or rejects pending withdrawal requests.
- **Setter** – manages roles and the withdrawal whitelist.
- **Rebalancer** – moves funds from the vault to whitelisted addresses.
- **Signer** – signs (EIP-712) the message a user needs to request a withdrawal.

## Setup

```shell
npm install
```

## Run the full scenario

Deploys a mock collateral token and the vault on a throwaway in-process Hardhat
network, then walks the whole lifecycle (deposits → withdrawal accepted / rejected
/ canceled → treasury rebalance → pause/unpause) with `[PASS]` assertions at each
step. No `.env`, private key, or separate node required:

```shell
npm run scenario
# or: npx hardhat run scripts/scenario.ts
```

## Other commands

```shell
npm test            # run the unit test suite (npx hardhat test)
npm run compile     # compile contracts + generate types (npx hardhat compile)
```

## Deploy / configure (real networks)

These need env vars and a `--network` (see `hardhat.config.ts`):

```shell
COLLATERAL_TOKEN=0x... npx hardhat run scripts/deploy.ts --network base
VAULT_ADDRESS=0x... npx hardhat run scripts/configure.ts --network base
```
