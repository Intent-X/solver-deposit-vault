/**
 * Reference implementation of the SolverVault SIGNER role.
 *
 * A user cannot call `requestWithdraw` on the vault without an EIP-712 signature
 * produced by an account that holds `SIGNER_ROLE`. This tiny Express service
 * shows how a backend would produce that signature.
 *
 * Policy in this example: auto-sign any request strictly BELOW $100, reject the
 * rest. Swap the `isAllowed` function for your real risk/business logic.
 *
 *   POST /sign-withdrawal
 *   {
 *     "user":     "0x...",          // who is withdrawing (msg.sender on-chain)
 *     "amount":   "50000000",       // RAW token units (same value passed to requestWithdraw)
 *     "receiver": "0x...",          // where funds go
 *     "nonce":    1,                // per-user unique nonce
 *     "deadline": 1735689600        // optional unix seconds; defaults to now + 1h
 *   }
 *
 * On success it returns the signature plus the exact tuple to forward to
 * `vault.requestWithdraw(amount, receiver, nonce, deadline, signature)`.
 */
import "dotenv/config";
import express from "express";
import { ethers } from "ethers";

// --- Configuration ----------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);
// Address that holds SIGNER_ROLE on the vault. The default below is the public,
// well-known Hardhat account #0 key — for LOCAL TESTING ONLY, never in prod.
const SIGNER_PRIVATE_KEY =
  process.env.SIGNER_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// The deployed SolverVault proxy — this is the EIP-712 `verifyingContract`.
const VAULT_ADDRESS = process.env.VAULT_ADDRESS ?? ethers.ZeroAddress;
// Chain the vault lives on (31337 = local Hardhat, 8453 = Base).
const CHAIN_ID = BigInt(process.env.CHAIN_ID ?? 31337);
// Collateral token decimals (mock / USDC = 6).
const COLLATERAL_DECIMALS = Number(process.env.COLLATERAL_DECIMALS ?? 6);
// Max amount (in whole dollars, exclusive) this service will auto-sign.
const MAX_WITHDRAWAL_USD = Number(process.env.MAX_WITHDRAWAL_USD ?? 100);

const MAX_WITHDRAWAL_RAW = ethers.parseUnits(
  String(MAX_WITHDRAWAL_USD),
  COLLATERAL_DECIMALS
);

const wallet = new ethers.Wallet(SIGNER_PRIVATE_KEY);

// EIP-712 domain + types — these MUST match the contract exactly.
// Contract: __EIP712_init("SolverVault", "1") and WITHDRAW_TYPEHASH.
const DOMAIN = {
  name: "SolverVault",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: VAULT_ADDRESS,
};
const TYPES = {
  WithdrawRequest: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "receiver", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// --- Business rule: decide whether to sign -----------------------------------

function isAllowed(amountRaw: bigint): boolean {
  // Sign only requests strictly below the configured threshold.
  return amountRaw < MAX_WITHDRAWAL_RAW;
}

// --- HTTP server -------------------------------------------------------------

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "SolverVault signer (example)",
    signer: wallet.address,
    vault: VAULT_ADDRESS,
    chainId: CHAIN_ID.toString(),
    maxWithdrawalUsd: MAX_WITHDRAWAL_USD,
    collateralDecimals: COLLATERAL_DECIMALS,
  });
});

app.post("/sign-withdrawal", async (req, res) => {
  try {
    const { user, amount, receiver, nonce, deadline } = req.body ?? {};

    // --- Validate input ---
    if (!ethers.isAddress(user)) {
      return res.status(400).json({ error: "Invalid 'user' address" });
    }
    if (!ethers.isAddress(receiver)) {
      return res.status(400).json({ error: "Invalid 'receiver' address" });
    }
    if (nonce === undefined || nonce === null || !Number.isInteger(Number(nonce))) {
      return res.status(400).json({ error: "Invalid 'nonce'" });
    }

    let amountRaw: bigint;
    try {
      amountRaw = BigInt(amount);
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid 'amount' (expected raw token units as string)" });
    }
    if (amountRaw <= 0n) {
      return res.status(400).json({ error: "'amount' must be greater than 0" });
    }

    const deadlineValue = BigInt(
      deadline ?? Math.floor(Date.now() / 1000) + 3600
    );

    const amountUsd = ethers.formatUnits(amountRaw, COLLATERAL_DECIMALS);

    // --- Apply the signing policy ---
    if (!isAllowed(amountRaw)) {
      return res.status(403).json({
        signed: false,
        reason: `Amount ${amountUsd} is not below the ${MAX_WITHDRAWAL_USD} limit; manual approval required.`,
      });
    }

    // --- Produce the EIP-712 signature ---
    const value = {
      user,
      amount: amountRaw,
      receiver,
      nonce: BigInt(nonce),
      deadline: deadlineValue,
    };
    const signature = await wallet.signTypedData(DOMAIN, TYPES, value);

    return res.json({
      signed: true,
      signer: wallet.address,
      signature,
      // Forward these straight to:
      //   vault.requestWithdraw(amount, receiver, nonce, deadline, signature)
      request: {
        user,
        amount: amountRaw.toString(),
        receiver,
        nonce: BigInt(nonce).toString(),
        deadline: deadlineValue.toString(),
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`SolverVault signer example listening on http://localhost:${PORT}`);
  console.log(`  signer address: ${wallet.address}`);
  console.log(`  vault:          ${VAULT_ADDRESS}`);
  console.log(`  chainId:        ${CHAIN_ID}`);
  console.log(
    `  auto-signs amounts below: ${MAX_WITHDRAWAL_USD} (= ${MAX_WITHDRAWAL_RAW} raw units)`
  );
});
