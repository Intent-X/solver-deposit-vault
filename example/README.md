# SolverVault Signer — Example Service

A minimal Express service showing how to implement the vault's **SIGNER** role.

The vault's `requestWithdraw` requires an EIP-712 signature from an account that
holds `SIGNER_ROLE`. This service receives a withdrawal request and returns a
valid signature **only if the amount is below $100** — otherwise it refuses.
Replace the `isAllowed` function with your real approval logic.

## Run

```shell
cd example
npm install
cp .env.example .env   # then edit VAULT_ADDRESS / CHAIN_ID for your deployment
npm start              # http://localhost:3000
```

> The default signer key is the public Hardhat account #0 — local testing only.
> For it to work on-chain, grant `SIGNER_ROLE` to the signer address and set
> `VAULT_ADDRESS` / `CHAIN_ID` to match your deployment.

## Endpoint

`POST /sign-withdrawal`

```jsonc
{
  "user":     "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // withdrawer (on-chain msg.sender)
  "amount":   "50000000",                                    // RAW token units (50 USDC @ 6 decimals)
  "receiver": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "nonce":    1,
  "deadline": 1893456000                                     // optional; defaults to now + 1h
}
```

### Allowed (below $100) → `200`

```jsonc
{
  "signed": true,
  "signer": "0xf39F...2266",
  "signature": "0x....",
  "request": { "user": "0x...", "amount": "50000000", "receiver": "0x...", "nonce": "1", "deadline": "..." }
}
```

The caller then submits it on-chain:

```ts
await vault.requestWithdraw(amount, receiver, nonce, deadline, signature);
```

### Rejected ($100 or more) → `403`

```jsonc
{ "signed": false, "reason": "Amount 100.0 is not below the 100 limit; manual approval required." }
```

## Quick test

```shell
# Allowed — 50 USDC (50000000 raw)
curl -s -X POST http://localhost:3000/sign-withdrawal \
  -H 'content-type: application/json' \
  -d '{"user":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","amount":"50000000","receiver":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","nonce":1}'

# Rejected — 100 USDC (100000000 raw)
curl -s -X POST http://localhost:3000/sign-withdrawal \
  -H 'content-type: application/json' \
  -d '{"user":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","amount":"100000000","receiver":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","nonce":2}'
```

## Notes for production

- **`amount` is in raw token units** — exactly the integer passed to
  `requestWithdraw`. The $100 threshold is `parseUnits("100", decimals)`.
- The EIP-712 `domain` / `types` here **must stay identical** to the contract
  (`name: "SolverVault"`, `version: "1"`, and the `WithdrawRequest` type). If they
  drift, `ECDSA.recover` on-chain yields a different address and the tx reverts.
- This example does **not** track nonces. In production, persist used nonces (and
  ideally rate-limit per user) so you never sign the same request twice.
- Keep the signer key in a KMS/HSM, not an env var, for real deployments.
