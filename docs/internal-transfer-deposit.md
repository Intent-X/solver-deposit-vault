# Internal Transfer Deposit Pathway — Specification

**Status:** Draft (DOCS-ONLY, no .sol changes in this task)
**Target contract:** `contracts/OnChainSymmioVaultV2.sol`
**Feature:** Add a second deposit pathway, `depositViaInternalTransfer`, that lets a user move
collateral that already lives on Symmio (under one of their MultiAccount sub-accounts) into the
solver's allocated balance — without ever moving ERC20 through the vault contract.
**Source of truth for upstream behaviour:** `perps-core@origin/version_0.8.5`. Every claim about
MultiAccount or Symmio cites a `path:line` in that ref. All MultiAccount line numbers below refer
to `contracts/helpers/accounts/MultiAccount.sol` at `origin/version_0.8.5` unless noted.

> **README staleness note.** The repo `README.md` (lines 1-14) still describes the V1 1:1 vault
> token model. V2 dropped vault tokens entirely — withdrawals are EIP-712-signed off-chain and
> settled by the Balancer role. This spec touches V2 only. The README should be rewritten as a
> separate task; for now we add a single pointer (see "README pointer" at the bottom).

---

## 1. Recap of current V2 deposit flow

V2 has exactly one deposit entry point today — `deposit(uint256)` —
(`contracts/OnChainSymmioVaultV2.sol:86-98`):

1. `whenNotPaused` + `nonReentrant` guards (line 86).
2. `require(amount > 0, ...)` and `require(currentDeposit + amount <= depositLimit, ...)`
   (lines 87-88).
3. `collateralToken.safeTransferFrom(_msgSender(), address(this), amount)` — pulls ERC20 from the
   caller into the vault (line 91).
4. `currentDeposit += amount; emit Deposit(_msgSender(), amount);` (lines 92-93).
5. `collateralToken.forceApprove(address(symmio), amount); symmio.depositFor(solver, amount);`
   pushes the same amount into Symmio's deposited balance for the solver address (lines 95-96).
6. `emit DepositToSymmio(_msgSender(), solver, amount);` (line 97).

State touched: `currentDeposit` only. No vault tokens are minted — V2 dropped that V1 mechanic.

### V2 withdraw flow (for context)

Withdrawals are gated by an EIP-712 `WithdrawRequest` signed by `signer` and submitted via
`requestWithdraw` (`contracts/OnChainSymmioVaultV2.sol:100-130`). The Balancer (`BALANCER_ROLE`)
settles requests on-chain in `acceptWithdrawRequest` (lines 156-190) by transferring the provided
amount from itself into the vault (line 161), and per-request decrementing `currentDeposit` and
incrementing `lockedBalance`. Users then claim via `claimForWithdrawRequest`
(lines 205-218) after `withdrawalPeriod`. A separate
`withdrawNotLockedCollateralTokens` (lines 192-203) lets the Balancer pull back any vault ERC20
above `lockedBalance`.

### Accounting state involved

- `lockedBalance` — collateral earmarked for accepted-but-not-yet-claimed withdraw requests
  (`contracts/OnChainSymmioVaultV2.sol:40`).
- `currentDeposit` — running tally of deposits, decremented by `acceptWithdrawRequest`
  (`contracts/OnChainSymmioVaultV2.sol:42`, decrement at line 176).
- `depositLimit` — admin cap on `currentDeposit` (line 41, default `10_000_000 * 10**6` line 79).
- `pendingWithdrawalAmount[user]` — unsettled withdraw request total per user (line 46).

---

## 2. New flow (Pull) end-to-end

The new entry point lets a user keep their funds inside their existing Symmio sub-account up
until the moment of deposit, then atomically move the funds from that sub-account's `balances`
(deposited) ledger into the solver's `allocatedBalances` ledger by invoking Symmio's
`internalTransfer` selector through MultiAccount's delegated-call path.

### Preconditions

**Precondition A — collateral is already inside the user's sub-account on Symmio.**
The typical paths users take to get there are:

- `MultiAccount.depositForAccount(account, amount)` —
  `perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:210-216`.
  Pulls ERC20 from the user, approves Symmio, calls `ISymmio.depositFor(account, amount)`. Funds
  land in the sub-account's deposited balance.
- `MultiAccount.depositAndAllocateForAccount(account, amount)` —
  `perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:221-231`. Same as
  above, then immediately allocates. Note that for the Pull deposit pathway we want the funds in
  the sub-account's **deposited** balance (Symmio `balances[signer]`), not its allocated balance,
  because Symmio's `internalTransfer` pulls from `balances[signer]`
  (`perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacetImpl.sol:143-154`,
  specifically the `accountLayout.balances[signer] -= amount` debit at line 152).

**Precondition B — user signs ONE pre-flight tx to MultiAccount granting the vault delegated
access to the `internalTransfer` selector for the chosen sub-account.**

```solidity
multiAccount.delegateAccess(subAccount, vault, IAccountFacet.internalTransfer.selector);
```

- `delegateAccess` is at
  `perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:77-81`. It is gated
  by the `onlyOwner(account, msg.sender)` modifier
  (`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:43-46`) and writes
  `delegatedAccesses[account][target][selector] = true` (line 80).
- The selector to delegate is `IAccountFacet.internalTransfer.selector`, declared at
  `perps-core@origin/version_0.8.5:contracts/core/facets/Account/IAccountFacet.sol:40` and
  implemented at
  `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:197-209`.
- `_call` enforces that gate at
  `perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:257-279`,
  specifically the `delegatedAccesses[account][msg.sender][functionSelector]` read at line 269.

This pre-flight is a **one-time** tx per `(subAccount, vault, selector)` triple — the user does
NOT need to re-grant on every deposit.

### Runtime call

```solidity
vault.depositViaInternalTransfer(address subAccount, uint256 amount)
```

Vault-side body (described, not implemented):

1. Vault guards: `whenNotPaused`, `nonReentrant`, `amount > 0`,
   `currentDeposit + amount <= depositLimit`, `multiAccount != address(0)`,
   `solverSubAccount != address(0)`.
2. **Ownership check** — `require(multiAccount.owners(subAccount) == msg.sender)`. See section 3.
3. Build `bytes[] memory calls` with one entry:
   `abi.encodeWithSelector(IAccountFacet.internalTransfer.selector, solverSubAccount, amount)`.
4. Call `multiAccount._call(subAccount, calls)`. This executes
   `ISymmioPartyA(subAccount)._call(callData)` (`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:248-256`),
   which forwards the call to Symmio with the sub-account as the on-chain signer. Symmio's
   `internalTransfer` then debits `balances[subAccount]` and credits
   `allocatedBalances[solverSubAccount]`
   (`perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacetImpl.sol:143-154`).
5. `currentDeposit += amount;`
6. `emit DepositViaInternalTransfer(msg.sender, subAccount, amount);` (new event, see below).

### New event

```solidity
event DepositViaInternalTransfer(address indexed depositor, address indexed subAccount, uint256 amount);
```

### Should we also emit the existing `Deposit` event for parity?

**Recommendation: NO** (mark as a design choice — flag for implementation review).
`Deposit` (`contracts/interfaces/IOnChainSymmioVault.sol:26`) currently signals "ERC20 entered
the vault". In the internal-transfer path no ERC20 touches the vault, so reusing `Deposit` would
mislead indexers that derive `vault.balanceOf(this)` deltas from it. Keep the two events
semantically distinct; indexers wanting a uniform stream can subscribe to both.

### `solverSubAccount` (new vault state)

The solver address used in `deposit()` is an EOA that Symmio holds funds for via `depositFor`.
For internal transfer, the destination must be the solver's MultiAccount sub-account address that
holds `allocatedBalances` on Symmio. We therefore need a new immutable-ish vault setter, e.g.
`solverSubAccount`, settable by `SETTER_ROLE`. Its absence (zero address) must revert
`depositViaInternalTransfer`. Implementation detail — out of scope here, but flagged.

---

## 3. Ownership check rationale

Inside `depositViaInternalTransfer`, the vault must:

```solidity
require(multiAccount.owners(subAccount) == msg.sender, "Vault: Not subAccount owner");
```

`owners` is the public mapping at
`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:30`.

### Why is this needed if `delegateAccess` itself is owner-gated?

`delegateAccess` IS owner-gated
(`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:77`). So in
principle, only the owner of `subAccount` could have authorised the vault to call
`internalTransfer` on that sub-account.

**But:** absent a vault-side ownership check, ANYONE could call
`depositViaInternalTransfer(subAccount, amount)` once delegation is in place — the vault would
happily call `multiAccount._call(...)`, the call would succeed (because `delegatedAccesses[...]`
is true regardless of who is currently calling the vault), and the user's funds would move from
their sub-account into the solver's allocated balance, with `currentDeposit` credited under the
attacker's tx (and crucially with the wrong `depositor` field in the event). This would let a
griefer:

- Front-run the legitimate user and steal the "depositor" attribution.
- Force-deposit funds from a user who has not yet revoked an old delegation.

**Defense-in-depth rationale:** the vault owns its own UX correctness. Even though the upstream
gate is sound for "is this delegation authorised?", the vault must additionally enforce
"is the caller the true owner of this sub-account?" so the deposit is unforgeable from the
vault's point of view. This is cheap (one storage read on MultiAccount).

---

## 4. Open design question (mark explicitly)

Two viable signatures for the new function. Pick one before implementation.

### Option A (RECOMMENDED) — explicit `subAccount` parameter

```solidity
function depositViaInternalTransfer(address subAccount, uint256 amount) external;
```

- **Pros:** supports users with multiple sub-accounts (`accounts[user]` is an array,
  `perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:28`); no vault-side
  registry → no extra storage, no extra tx, no upgrade migration; matches MultiAccount helpers'
  shape (`depositForAccount(address, uint256)` etc.).
- **Cons:** caller must know their sub-account address. Frontends already manage this.

### Option B — vault registry mapping owner → subAccount

```solidity
mapping(address => address) public registeredSubAccount;
function registerSubAccount(address subAccount) external; // user calls once
function depositViaInternalTransfer(uint256 amount) external; // uses registered
```

- **Pros:** single-arg deposit call.
- **Cons:** adds storage, registration tx, multi-sub-account ambiguity, ownership-transfer /
  deletion edge cases. The registration tx is on the vault while `delegateAccess` is on
  MultiAccount — net UX is **two** pre-flight txs (worse, not better).

**Recommendation: Option A.** Lower complexity, and Option B's "single-arg" win doesn't actually
save the user a transaction given the mandatory MultiAccount pre-flight.

---

## 5. Revocation mechanics & UX implication

Delegations are revoked in two steps via MultiAccount:

1. `proposeToRevokeAccesses(account, target, selectors)` — owner calls; sets
   `revokeProposalTimestamp[account][target][selector] = block.timestamp` for each selector
   (`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:109-115`).
2. After `revokeCooldown` seconds elapse,
   `revokeAccesses(account, target, selectors)` actually flips
   `delegatedAccesses[account][target][selector] = false`
   (`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:121-132`).
   `revokeCooldown` is set by SETTER_ROLE via `setRevokeCooldown`
   (`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:144-147`).

There is also a single-selector grant via `delegateAccess`
(`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:77-81`) and a batch
grant via `delegateAccesses`
(`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:97-103`).

### UX implication

Until the cooldown elapses and `revokeAccesses` is actually called, `delegatedAccesses[...]`
stays `true`. So a `depositViaInternalTransfer` call between `proposeToRevokeAccesses` and the
final `revokeAccesses` **will succeed**. From the user's point of view that may feel surprising
("I started revoking, why did my deposit go through?"). The vault should not paper over this —
**the vault must surface the upstream `MultiAccount: Unauthorized access` revert reason verbatim
when it does fail** (after the actual revocation). Wrapping the revert in a vault-specific error
would obscure the root cause for users and indexers.

**No mitigation needed in vault code** — `_call` already reverts with the upstream reason via
`innerCall`'s assembly bubble-up
(`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:240-247`).

---

## 6. Revert taxonomy planned for the implementation phase

Enumerated only — no Solidity here. Categorised by where the revert originates.

### Vault-side reverts (msg.sender's tx fails before reaching MultiAccount)

| # | Condition | Revert origin |
|---|-----------|---------------|
| V1 | Vault is paused | `whenNotPaused` modifier (OpenZeppelin `PausableUpgradeable`, used at `contracts/OnChainSymmioVaultV2.sol:86` style) |
| V2 | `multiAccount` unset (zero address) | new vault require |
| V3 | `solverSubAccount` unset (zero address) | new vault require |
| V4 | `amount == 0` | new vault require (matches `deposit()` at line 87) |
| V5 | `currentDeposit + amount > depositLimit` | new vault require (matches `deposit()` at line 88) |
| V6 | `msg.sender != multiAccount.owners(subAccount)` | new vault require (see section 3) |

### MultiAccount-side reverts (we never reach Symmio)

| # | Condition | Source |
|---|-----------|--------|
| M1 | MultiAccount paused | `whenNotPaused` on `_call` (`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:257`) |
| M2 | `delegatedAccesses[subAccount][vault][internalTransfer.selector] == false` (never granted, or revoked, or freshly proposed-then-revoked) | `_call` line 268-271; reverts with `"MultiAccount: Unauthorized access"` |
| M3 | call data malformed (length < 4) | `_call` line 264 |

### Symmio-side reverts (call reaches the diamond and is rejected by core)

| # | Condition | Source |
|---|-----------|--------|
| S1 | `internalTransferPaused == true` (Symmio internal transfer paused) | `whenNotInternalTransferPaused` modifier; `internalTransferPaused` flag at `perps-core@origin/version_0.8.5:contracts/core/storages/GlobalAppStorage.sol:72`; modifier at `perps-core@origin/version_0.8.5:contracts/core/utils/Pausable.sol:47-51`. Toggled by `PauseControlFacet.suspendInternalTransfer` at `perps-core@origin/version_0.8.5:contracts/core/facets/PauseControl/PauseControlFacet.sol:55` |
| S2 | `globalPaused == true` or `accountingPaused == true` | same `whenNotInternalTransferPaused` modifier |
| S3 | signer (subAccount) suspended | `notSuspended(LibSigner.getSigner())` at `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:200` → modifier at `perps-core@origin/version_0.8.5:contracts/core/utils/Accessibility.sol:110-113` |
| S4 | recipient (solverSubAccount) suspended | `notSuspended(user)` at `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:200` |
| S5 | recipient is registered as PartyB | `userNotPartyB(user)` at `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:200` → modifier at `perps-core@origin/version_0.8.5:contracts/core/utils/Accessibility.sol:27-30` |
| S6 | recipient is currently being liquidated | `notLiquidatedPartyA(user)` at `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:200` → modifier at `perps-core@origin/version_0.8.5:contracts/core/utils/Accessibility.sol:68-71` |
| S7 | recipient's effective allocated balance + amount > `balanceLimitPerUser` | `AccountFacetImpl.internalTransfer` at `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacetImpl.sol:147-150` |
| S8 | `balances[subAccount] < amount` (insufficient deposited balance) | `AccountFacetImpl.internalTransfer` at `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacetImpl.sol:151` |

All Symmio reverts bubble up through MultiAccount via the assembly revert in `innerCall`
(`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:240-247`), then up
through the vault. **The vault must NOT swallow these.** Recommend: do not wrap the
`multiAccount._call` invocation in a try/catch; let it propagate.

---

## 7. Accounting impact

This pathway introduces a *new* invariant gap that the V2 design implicitly relied on. Read this
section carefully — it has implications for the Balancer's operational model.

### State changes per call

| Variable | `deposit(amount)` (current) | `depositViaInternalTransfer(subAccount, amount)` (new) |
|----------|----------------------------|--------------------------------------------------------|
| `currentDeposit` | `+= amount` | `+= amount` |
| `depositLimit` | unchanged (gated against) | unchanged (gated against) |
| `lockedBalance` | unchanged | unchanged |
| `IERC20(collateralToken).balanceOf(address(this))` | `+= amount` (then `-= amount` after `depositFor`, net 0 for non-fee tokens) | **unchanged — no ERC20 ever touches the vault** |
| Symmio `balances[solver]` | `+= amount` (the EOA solver's deposited ledger) | unchanged |
| Symmio `balances[subAccount]` | unchanged | `-= amount` (`AccountFacetImpl.internalTransfer` line 152) |
| Symmio `allocatedBalances[solverSubAccount]` | unchanged | `+= amount` (`AccountFacetImpl.internalTransfer` line 153) |

### CRITICAL CALLOUT — vault ERC20 balance no longer tracks `currentDeposit`

In the legacy path every credit to `currentDeposit` was preceded by a real ERC20 transfer into
the vault. With the internal-transfer path, `currentDeposit` increments **without** ERC20
entering the vault — collateral lives entirely inside Symmio's `allocatedBalances[solverSubAccount]`
ledger. Implications:

1. `withdrawNotLockedCollateralTokens` (`contracts/OnChainSymmioVaultV2.sol:192-203`) is
   unchanged but skims a smaller pool, since vault ERC20 balance no longer scales with
   `currentDeposit`.
2. `acceptWithdrawRequest` (`contracts/OnChainSymmioVaultV2.sol:156-190`) is unchanged and still
   pulls `providedAmount` from the Balancer (line 161). It just has to fire more often / for
   larger amounts.
3. `claimForWithdrawRequest` (`contracts/OnChainSymmioVaultV2.sol:205-218`) is unchanged and
   pays out from `lockedBalance` ERC20 deposited by the Balancer at accept time.

### Does the Balancer need to bring liquidity?

**Yes — and it always could.** `acceptWithdrawRequest` already pulls `providedAmount` from the
Balancer (line 161). The internal-transfer pathway just makes it the *only* funding source,
because the vault's local ERC20 is no longer organically replenished by user deposits. This is
a quantitative shift, not a new mechanism, but it's load-bearing on Balancer ops and should be
flagged in the runbook.

### Invariants worth asserting in tests (during implementation)

- After `depositViaInternalTransfer`: `currentDeposit` increased by `amount`; vault ERC20 balance
  unchanged.
- After `depositViaInternalTransfer`: Symmio `allocatedBalances[solverSubAccount]` increased by
  `amount` (in 18-decimal Symmio units — note the decimal scaling done by Symmio internally; the
  vault passes `amount` in collateral-token decimals only if Symmio expects that — confirm during
  implementation, see `LibAccount.toCollateralDecimals` referenced at
  `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:206`).
- Sum-of-deposits invariant: `currentDeposit == sum_legacy_deposits + sum_internal_transfer_deposits - sum_accepted_amounts`.

---

## 8. Hooks

### Symmio 0.8.5 does NOT fire an account-layer hook for `internalTransfer` recipients.

The hook interface is defined at
`perps-core@origin/version_0.8.5:contracts/accountLayer/interfaces/IAccountLayerHook.sol:8-36`.
Its surface is exactly five callbacks:

- `onAccountCreation` (line 14)
- `onVirtualAccountCreation` (line 21)
- `onVirtualAccountDeletion` (line 25)
- `onSubAccountDeletion` (line 30)
- `onCall` (line 35)

There is **no `onInternalTransfer`** and no recipient-side callback for ALLOCATE events.
`onCall` fires after `_call` executes against the *signer's* sub-account — not against the
recipient sub-account of an internal transfer. Hook registration is via
`AffiliateFacet.setHook(affiliate, selector, hook)` at
`perps-core@origin/version_0.8.5:contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:282-290`
— it lets affiliates register a hook for a given selector, but this does not reach the Symmio
core diamond's `internalTransfer` selector via any callback the recipient (the solver
sub-account / the vault) can subscribe to.

A `git --no-pager grep -n internalTransfer origin/version_0.8.5 -- 'contracts/'` confirms that
all `internalTransfer` references are either the selector-level usage in
`accountLayer/facets/Margin/MarginFacet.sol` (lines 30, 66 — outbound calls, not callbacks), the
core implementation
(`contracts/core/facets/Account/AccountFacet.sol:197-209` and
`contracts/core/facets/Account/AccountFacetImpl.sol:143-154`), the interface declaration
(`contracts/accountLayer/interfaces/ISymmio.sol:197`), pause flags, and view-facet returns —
**none** of them dispatch a hook to the recipient sub-account or its affiliate.

### Why this drives "Pull" over "Push"

A "Push" design would have Symmio notify the vault that funds had arrived. Without a hook on
`internalTransfer`, **Symmio cannot notify the vault.** Off-chain indexer push adds a trust
assumption and is unsuitable for on-chain `currentDeposit` accounting; piggy-backing `onCall`
fires on every `_call` (noisy) and requires an affiliate we control, and still misses internal
transfers initiated outside `_call`. **Pull** sidesteps this by making the vault the on-chain
caller — it knows the transfer succeeded because it issued the `_call`, and increments
`currentDeposit` synchronously. This is the core architectural reason for the Pull shape.

---

## 9. ASCII sequence diagram

```text
PRE-FLIGHT (once per (subAccount, vault, selector)):

  User EOA ──delegateAccess(subAccount, vault, internalTransfer.selector)──► MultiAccount
                                                                              │
                                                       delegatedAccesses[..][..][..] = true
                                                       emit DelegateAccess

RUNTIME (per deposit):

  User EOA
     │
     │ depositViaInternalTransfer(subAccount, amount)
     ▼
  Vault ──── checks: whenNotPaused, amount>0, currentDeposit+amt<=limit,
     │               multiAccount!=0, solverSubAccount!=0,
     │               owners(subAccount) == msg.sender
     │
     │ multiAccount._call(subAccount, [abi.encodeWithSelector(
     │                                  IAccountFacet.internalTransfer.selector,
     │                                  solverSubAccount, amount_18dec)])
     ▼
  MultiAccount ─── checks: whenNotPaused,
     │                     delegatedAccesses[subAccount][vault][selector] == true
     │
     │ ISymmioPartyA(subAccount)._call(callData)
     ▼
  subAccount (ISymmioPartyA)
     │
     │ Symmio.internalTransfer(solverSubAccount, amount_18dec)  // signer = subAccount
     ▼
  Symmio diamond
     │   debit  balances[subAccount]              -= amount_18dec
     │   credit allocatedBalances[solverSubAcct]  += amount_18dec
     │   emit InternalTransfer / Withdraw / AllocatePartyA / SharedEvents.BalanceChangePartyA
     ▼
   (returns up the stack)
     │
  MultiAccount: emit Call(vault, subAccount, callData, true, returnData)
     │
  Vault: currentDeposit += amount
         emit DepositViaInternalTransfer(msg.sender, subAccount, amount)
```

### Events to expect on a successful tx (in order)

1. `MultiAccount.Call(msg.sender=vault, subAccount, callData, success=true, returnData)` —
   emitted in `innerCall` at
   `perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:241`.
2. Symmio `InternalTransfer(signer=subAccount, user=solverSubAccount, allocatedBalance, amount)`
   — `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:204`.
3. Symmio `Withdraw(signer=subAccount, user=solverSubAccount, amountInCollateralDecimals)` —
   `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:205`.
4. Symmio `AllocatePartyA(user=solverSubAccount, amount, allocatedBalance)` —
   `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:206`.
5. Symmio `SharedEvents.BalanceChangePartyA(user=solverSubAccount, amount, ALLOCATE)` —
   `perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:207`.
6. Vault `DepositViaInternalTransfer(depositor=msg.sender, subAccount, amount)` — new.

The `DelegateAccess` event is emitted only on the pre-flight tx, not on the runtime deposit tx
(`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:79`).

---

## Open questions / assumptions surfaced during this spec

1. **Decimal handling.** Symmio's `internalTransfer` accepts `amount` in 18 decimals
   (`perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacet.sol:197-198`).
   `depositAndAllocateForAccount` does the scaling itself
   (`perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:226`). The vault
   currently calls `symmio.depositFor(solver, amount)` with collateral-decimal `amount`
   (`contracts/OnChainSymmioVaultV2.sol:96`), and the `Withdraw` event in `internalTransfer`
   logs `LibAccount.toCollateralDecimals(amount)` — implying the function expects 18-dec input.
   **Implementation must scale `amount` from collateral decimals to 18 decimals before calling
   `internalTransfer`**, matching the pattern in
   `perps-core@origin/version_0.8.5:contracts/helpers/accounts/MultiAccount.sol:226`. Confirm.
2. **`solverSubAccount` lifecycle.** The vault's existing `solver` is an EOA that receives
   `depositFor`. The new pathway needs the *sub-account* (an `ISymmioPartyA` instance owned by
   the solver in MultiAccount) where `allocatedBalances` accrue. Open: should the new vault
   storage be `solverSubAccount` (decoupled from `solver`) or should we deprecate `solver`?
   Defer to implementation phase, but the simplest path is to add a new `solverSubAccount`
   setter and leave `solver` for the legacy pathway.
3. **`balanceLimitPerUser`.** Symmio enforces a per-user allocated cap
   (`perps-core@origin/version_0.8.5:contracts/core/facets/Account/AccountFacetImpl.sol:147-150`).
   For the solver's sub-account the cap may be high, but worth a runbook note: if it's ever
   tightened, large internal-transfer deposits will start reverting at S7 and the vault must
   surface that.
4. **Gas / DOS.** `_call` accepts `bytes[]`; we always pass length 1. No batching DoS surface.

---

## README pointer

Add ONE line under the existing "Main Functions" heading in `README.md` linking to this spec:

```markdown
- See [docs/internal-transfer-deposit.md](docs/internal-transfer-deposit.md) for the planned
  Internal Transfer deposit pathway (V2 spec, not yet implemented).
```

(Done in the same atomic commit as this spec.)
