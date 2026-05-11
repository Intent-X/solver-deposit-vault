# Deposit via `internalTransfer` — Design Doc

**Status:** Draft (DOCS-ONLY — no `.sol` changes in this task; this doc is the input to the
implementation task `p1-t2`).
**Target contract:** `contracts/OnChainSymmioVaultV2.sol`.
**Feature:** Add a second deposit entry point — `depositViaInternalTransfer(subAccount, amount)` —
that lets a user move collateral that already sits inside their own Symmio MultiAccount
sub-account into the solver's *allocated* Symmio balance, without ever moving an ERC20 through
the vault contract, and credits the same `currentDeposit` accounting (and emits the same
`Deposit` event) the existing wallet-based `deposit()` path does.

> **README staleness note.** The repo `README.md` still describes the V1 1:1 vault-token model.
> V2 (`contracts/OnChainSymmioVaultV2.sol`) dropped vault tokens entirely: there is no share
> token and no per-user balance mapping. The vault tracks a single global `currentDeposit`, and
> withdrawals are authorised off-chain by an EIP-712 signature from `signer` (`requestWithdraw`)
> and settled on-chain by `BALANCER_ROLE` (`acceptWithdrawRequest` / `claimForWithdrawRequest`).
> This doc only touches V2. Treat the README as partly stale; do not rely on it for V2 behaviour.

---

## 1. Scope and non-goals

### In scope

- **Arbitrum One only (chainId `42161`).** The vault, the Symmio Diamond, and the MultiAccount
  contract this design references are all the Arbitrum deployments. The frontend gates the
  "deposit from SYMM balance" UI to Arbitrum. This doc does not attempt to be chain-generic; if
  the vault is ever deployed to another chain, the internal-transfer path must be re-reviewed
  against that chain's Symmio/MultiAccount deployment and pause/limit semantics.
- **Available (deposited) Symmio balance only.** The funds being moved must already be in the
  user's sub-account *deposited* balance on Symmio (`balanceOf` / "available" in carbon UI terms)
  — i.e. not allocated. Symmio's `internalTransfer` debits the signer's deposited balance.
- **No Muon.** `internalTransfer` is an account-layer operation; it requires no Muon price
  signature. There is no Muon signature parameter on the new vault function and no Muon handling
  in any deposit callback. (Contrast: deallocate/withdraw flows on Symmio *do* involve Muon, but
  those are out of scope — see below.)

### Out of scope / explicit non-goals

- **No deallocate.** If a user only has *allocated* funds in their sub-account, this path cannot
  move them. The user must first deallocate via the existing carbon Withdraw UI (a separate
  transaction against Symmio / MultiAccount, not against this vault), wait out any cooldown, and
  then call `depositViaInternalTransfer` once the funds are back in the deposited balance. The
  vault will not (and must not) try to orchestrate the deallocate; it would pull in Muon, a
  cooldown state machine, and partyA-liquidation edge cases that are explicitly excluded here.
- **No Muon signature handling** anywhere in the contract or in the deposit path.
- **No non-Arbitrum chains.**
- **No shares / no per-user mapping.** This path does not introduce a share token, a per-user
  deposit mapping, or any per-user vault accounting. It increments the single global
  `currentDeposit` and emits events, exactly like `deposit()`. Per-user crediting is the job of
  an off-chain, event-driven indexer (see §6).
- **No try/catch wrapping** of the MultiAccount call: upstream reverts must bubble up verbatim
  (see §8).

---

## 2. Current V2 state and the existing deposit path (recap)

`OnChainSymmioVaultV2` is a UUPS-upgradeable contract mixing `AccessControlEnumerableUpgradeable`,
`PausableUpgradeable`, `EIP712Upgradeable`, and `ReentrancyGuardUpgradeable`.

Roles: `BALANCER_ROLE`, `SETTER_ROLE`, `PAUSER_ROLE`, `UNPAUSER_ROLE`
(`contracts/OnChainSymmioVaultV2.sol:27-30`).

Storage layout, in declaration order (`contracts/OnChainSymmioVaultV2.sol:36-47`):

1. `ISymmio public symmio`
2. `address public solver`
3. `address public signer`
4. `address public collateralTokenAddress`
5. `uint256 public lockedBalance`
6. `uint256 public depositLimit`
7. `uint256 public currentDeposit`
8. `uint256 public collateralTokenDecimals`
9. `WithdrawRequest[] public withdrawRequests`
10. `uint256 public withdrawalPeriod`
11. `mapping(address => uint256) public pendingWithdrawalAmount`
12. `mapping(address => mapping(uint256 => bool)) public usedNonces`

The existing deposit entry point — `deposit(uint256 amount)`
(`contracts/OnChainSymmioVaultV2.sol:86-98`):

1. `whenNotPaused nonReentrant`.
2. `require(amount > 0, "SymmioSolverDepositor: Amount must be greater than 0")`.
3. `require(currentDeposit + amount <= depositLimit, "SymmioSolverDepositor: Deposit limit reached")`.
4. `IERC20(collateralTokenAddress).safeTransferFrom(_msgSender(), address(this), amount)` — pulls
   the collateral ERC20 from the caller into the vault.
5. `currentDeposit += amount; emit Deposit(_msgSender(), amount);`
6. `collateralToken.forceApprove(address(symmio), amount); symmio.depositFor(solver, amount);`
7. `emit DepositToSymmio(_msgSender(), solver, amount);`

`Deposit(address indexed depositor, uint256 amount)` is declared in
`contracts/interfaces/IOnChainSymmioVault.sol:26`.

Errors throughout the contract use the string style `require(cond, "SymmioSolverDepositor: <message>")`.
The new code must follow that style.

`ISymmio` (`contracts/interfaces/ISymmio.sol`) currently declares only `getCollateral()` and
`depositFor(address,uint256)`. The implementation task will need to extend it (see §4 and §5).

### The two sinks — by design

| Path | On-chain call chain | Where the funds land on Symmio |
|------|--------------------|--------------------------------|
| `deposit(amount)` (wallet path, exists today) | vault pulls ERC20 → `symmio.depositFor(solver, amount)` | `solver`'s **available (deposited)** Symmio balance |
| `depositViaInternalTransfer(subAccount, amount)` (this design) | `multiAccount._call(subAccount, [internalTransfer(solverSubAccount, amount)])` | `solverSubAccount`'s **allocated** Symmio balance |

The two destinations (`solver` deposited vs `solverSubAccount` allocated) are intentionally
distinct: the wallet path tops up the bucket the vault has always topped up; the internal-transfer
path delivers directly into the allocated bucket the solver trades against, which is what a user
who already has SYMM balance wants. The vault must therefore hold **both** a `solver` address
(legacy) and a `solverSubAccount` address (new) — see §3.

---

## 3. Required storage additions (for `p1-t2`)

The contract does **not** yet contain `depositViaInternalTransfer`, nor `multiAccount`, nor
`solverSubAccount`. The implementation task must add the following. Because this contract is
UUPS-upgradeable, **all new state variables MUST be appended after the last existing variable
(`usedNonces`)** so the upgrade storage layout is preserved. Do not insert anything between
existing variables, do not reorder, do not change types.

```solidity
// --- appended after `mapping(address => mapping(uint256 => bool)) public usedNonces;` ---

/// @notice Symmio MultiAccount (Arbitrum) used to issue delegated `_call`s on behalf of users.
IMultiAccount public multiAccount;

/// @notice The solver's Symmio sub-account whose *allocated* balance receives internal transfers.
address public solverSubAccount;
```

(If a storage gap is later desired for safety, that is an orthogonal change and should be
proposed separately; it is not required for this feature and is not part of `p1-t2`.)

### New interface — `IMultiAccount`

Add `contracts/interfaces/IMultiAccount.sol` with the minimal surface this vault needs:

```solidity
interface IMultiAccount {
    function owners(address account) external view returns (address);
    function _call(address account, bytes[] calldata _callDatas) external;
}
```

- `owners(subAccount)` returns the EOA that owns that MultiAccount sub-account. Used for the
  authorisation check (step 2 of the flow).
- `_call(account, callDatas)` forwards each `callData` to the sub-account, which relays it to the
  Symmio Diamond with the sub-account as the on-chain caller. It is gated upstream by
  `delegatedAccesses[account][msg.sender][selector] == true`. We always pass a length-1 array.

### Extend `ISymmio`

Add the read used to snapshot the destination's allocated balance for the front-run guard:

```solidity
interface ISymmio {
    function getCollateral() external view returns (address);
    function depositFor(address user, uint256 amount) external;
    function allocatedBalanceOfPartyA(address partyA) external view returns (uint256); // new
}
```

`allocatedBalanceOfPartyA` is a view on the Symmio Diamond returning the partyA allocated balance
(in Symmio's internal 18-decimal accounting units).

### New constant — the `internalTransfer` selector

The vault must encode the selector for Symmio's `internalTransfer(address user, uint256 amount)`.
Define it as a constant rather than relying on importing the full Symmio account-facet interface:

```solidity
// selector of IAccountFacet.internalTransfer(address,uint256) on the Symmio Diamond
bytes4 public constant INTERNAL_TRANSFER_SELECTOR = bytes4(keccak256("internalTransfer(address,uint256)"));
```

(The implementation task should double-check this selector against the deployed Arbitrum Diamond
ABI before shipping; if the canonical signature differs, fix the constant. The signature above is
the expected one.)

### New setters (both `SETTER_ROLE`-gated, zero-address-checked, event-emitting)

Match the shape of the existing `setSolver` / `setSigner` (`contracts/OnChainSymmioVaultV2.sol:236-246`):

```solidity
function setMultiAccount(address _multiAccount) public onlyRole(SETTER_ROLE) {
    require(_multiAccount != address(0), "SymmioSolverDepositor: Zero address");
    multiAccount = IMultiAccount(_multiAccount);
    emit MultiAccountUpdatedEvent(_multiAccount);
}

function setSolverSubAccount(address _solverSubAccount) public onlyRole(SETTER_ROLE) {
    require(_solverSubAccount != address(0), "SymmioSolverDepositor: Zero address");
    solverSubAccount = _solverSubAccount;
    emit SolverSubAccountUpdatedEvent(_solverSubAccount);
}
```

### New events

Add to `contracts/interfaces/IOnChainSymmioVault.sol`:

```solidity
event MultiAccountUpdatedEvent(address indexed multiAccount);
event SolverSubAccountUpdatedEvent(address indexed solverSubAccount);
event DepositViaInternalTransfer(address indexed depositor, address indexed subAccount, uint256 amount);
```

> `initialize()` does NOT need to set `multiAccount` / `solverSubAccount` — they default to
> `address(0)`, and `depositViaInternalTransfer` reverts while either is zero (step 1). They are
> configured post-deploy via the setters above. Adding them as `initialize` params is acceptable
> but not required; if added, keep the existing params in place and append the new ones (same
> upgrade-safety reasoning), and keep them optional in the deployment script.

---

## 4. Precondition (user-side, one-time)

Before a user can use this path, they must have granted the vault delegated access to the
`internalTransfer` selector on their chosen sub-account, via the Symmio MultiAccount:

```solidity
// user (the sub-account owner) calls, once, on MultiAccount:
multiAccount.delegateAccess(subAccount, vault, internalTransferSelector); // selector = INTERNAL_TRANSFER_SELECTOR
```

This sets `delegatedAccesses[subAccount][vault][internalTransferSelector] = true` on MultiAccount.
`delegateAccess` is owner-gated upstream, so only the sub-account owner can authorise this. It is a
one-time tx per `(subAccount, vault, selector)` triple; it does not need to be repeated per deposit.
The frontend handles this pre-flight tx (and the carbon Withdraw/deallocate tx if the user only has
allocated funds — see §1 non-goals).

The user must also actually have `>= amount` of *deposited* (available) balance in that sub-account
on Symmio at call time, or the Symmio-side `internalTransfer` reverts (revert taxonomy §8, `S-balance`).

---

## 5. Vault flow — `depositViaInternalTransfer(address subAccount, uint256 amount)`

`external whenNotPaused nonReentrant` (same modifiers as `deposit()`).

The exact body, in order. (Implementation note: the config/zero-address guards run **before** the
owner check — `multiAccount.owners(subAccount)` would itself revert if `multiAccount` were the zero
address, so the `address(multiAccount) != 0` and `solverSubAccount != 0` requires must come first.
The set of checks is what matters, not the within-block ordering; the code in
`contracts/OnChainSymmioVaultV2.sol` orders them: `multiAccount != 0`, `solverSubAccount != 0`,
`amount > 0`, `currentDeposit + amount <= depositLimit`, then the owner check.)

1. **Config + amount guards.**
   - `require(address(multiAccount) != address(0), "SymmioSolverDepositor: Zero address");`
   - `require(solverSubAccount != address(0), "SymmioSolverDepositor: Zero address");`
   - `require(amount > 0, "SymmioSolverDepositor: Amount must be greater than 0");`
   - `require(currentDeposit + amount <= depositLimit, "SymmioSolverDepositor: Deposit limit reached");`
   (The `amount > 0` and deposit-limit messages reuse the exact strings from `deposit()` for
   indexer/UX consistency.)

2. **Owner check.**
   `require(multiAccount.owners(subAccount) == _msgSender(), "SymmioSolverDepositor: Not subAccount owner");`
   — without this, anyone could call `depositViaInternalTransfer(subAccount, amount)` once a
   delegation exists and move that user's funds / steal the `depositor` attribution in the event.
   The upstream `delegateAccess` gate proves the *delegation* was authorised by the owner; this
   vault-side check additionally proves the *caller* is that owner. Cheap (one external view).

3. **Snapshot the destination's allocated balance.**
   `uint256 oldAllocated = symmio.allocatedBalanceOfPartyA(solverSubAccount);`

4. **Issue the delegated internal transfer.**
   ```solidity
   bytes[] memory calls = new bytes[](1);
   calls[0] = abi.encodeWithSelector(INTERNAL_TRANSFER_SELECTOR, solverSubAccount, amount);
   multiAccount._call(subAccount, calls);
   ```
   This relays `internalTransfer(solverSubAccount, amount)` to the Symmio Diamond with `subAccount`
   as the on-chain caller, debiting `subAccount`'s deposited balance and crediting
   `solverSubAccount`'s allocated balance. (On the `amount` units: the existing `deposit()` passes
   collateral-decimal `amount` to `symmio.depositFor`. The implementation task must confirm against
   the deployed Arbitrum Diamond whether `internalTransfer` expects collateral decimals or 18
   decimals, and scale accordingly. The step-5 assertion is written against whatever unit
   `allocatedBalanceOfPartyA` and the credit use — keep them consistent. If scaling is needed,
   compare `newAllocated - oldAllocated` to the *scaled* amount.)

5. **Front-run / correctness guard.**
   ```solidity
   uint256 newAllocated = symmio.allocatedBalanceOfPartyA(solverSubAccount);
   require(newAllocated - oldAllocated == amount, "SymmioSolverDepositor: Allocated balance mismatch");
   ```
   This asserts the call actually moved exactly `amount` into the destination's allocated bucket.
   It defends against: a malformed/no-op `_call` that silently succeeds; a concurrent unrelated
   change to the destination's allocated balance racing this tx (defensive — we only credit when
   the delta is exactly ours); and any future Symmio behaviour change that would make the transfer
   partial. If the delta is not exactly `amount`, the whole tx reverts and nothing is credited.
   (Subtraction underflow here would itself revert, which is also acceptable — it can only happen
   if the destination's allocated balance *decreased* across our call, which means our deposit
   didn't land.)

6. **Credit + events.**
   ```solidity
   currentDeposit += amount;
   emit Deposit(_msgSender(), amount);                              // SAME event the wallet path emits
   emit DepositViaInternalTransfer(_msgSender(), subAccount, amount);
   ```
   The `Deposit` event carries the user's EOA (`_msgSender()`) as the `depositor` — identical
   shape to `deposit()` — so an event-driven indexer credits the user automatically with no new
   code path. `DepositViaInternalTransfer` is the path-specific record (which sub-account funded
   it).

There is **no** `forceApprove` / `safeTransferFrom` / `depositFor` in this path — no ERC20 ever
touches the vault.

### ASCII sequence

```text
PRE-FLIGHT (once, user EOA -> MultiAccount):
  delegateAccess(subAccount, vault, INTERNAL_TRANSFER_SELECTOR)
    => delegatedAccesses[subAccount][vault][selector] = true

RUNTIME (per deposit):
  User EOA
    │ depositViaInternalTransfer(subAccount, amount)
    ▼
  Vault  (1) require multiAccount!=0; solverSubAccount!=0;
                     amount>0; currentDeposit+amount<=depositLimit
         (2) require multiAccount.owners(subAccount) == msg.sender
         (3) oldAllocated = symmio.allocatedBalanceOfPartyA(solverSubAccount)
         (4) multiAccount._call(subAccount, [internalTransfer(solverSubAccount, amount)])
    ▼
  MultiAccount  require !paused; require delegatedAccesses[subAccount][vault][selector]
    │ subAccount._call(callData)
    ▼
  subAccount (ISymmioPartyA) ──► Symmio Diamond.internalTransfer(solverSubAccount, amount)
                                   debit  deposited[subAccount]        -= amount
                                   credit allocated[solverSubAccount]  += amount
    ▼ (returns up the stack)
  Vault  (5) newAllocated = symmio.allocatedBalanceOfPartyA(solverSubAccount)
         (5) require newAllocated - oldAllocated == amount
         (6) currentDeposit += amount
         (6) emit Deposit(msg.sender, amount)
         (6) emit DepositViaInternalTransfer(msg.sender, subAccount, amount)
```

---

## 6. Accounting model & the two ways it could break

There is no share token and no per-user mapping. User-facing accounting is entirely
**event-driven**: an off-chain indexer watches `Deposit(depositor, amount)` (emitted by both
`deposit()` and `depositViaInternalTransfer`) and `DepositViaInternalTransfer(...)` and credits
the `depositor` EOA. Withdrawals are authorised off-chain by `signer` (EIP-712) and settled by
`BALANCER_ROLE`. The on-chain global tally is `currentDeposit` (capped by `depositLimit`).

Because this path increments `currentDeposit` without ERC20 entering the vault (the collateral
sits in Symmio's allocated bucket for `solverSubAccount`), the vault's local ERC20 balance no
longer scales with `currentDeposit`. This is a known consequence; the Balancer already funds
withdrawals out-of-band via `acceptWithdrawRequest`, so it is a quantitative shift in Balancer
ops, not a new mechanism — but it should be in the Balancer runbook.

### Two ways this design could break — to be investigated in `p1-t3`

1. **Anti-spoof / ERC20-inflow guard on the indexer or any consumer of `Deposit`.**
   If the indexer (or any downstream consumer) treats `Deposit` as "an ERC20 of this size entered
   the vault" — e.g. cross-checks the event against an actual `Transfer` into the vault address —
   then `depositViaInternalTransfer`'s `Deposit` will fail that check, because no ERC20 moves.
   The indexer must be updated to accept `Deposit` events that are *not* accompanied by an ERC20
   inflow (distinguishing the two paths via the co-emitted `DepositViaInternalTransfer`, or via
   the absence of `DepositToSymmio`). `p1-t3` investigates whether such a guard exists.

2. **Balancer collateral total not covering the allocated bucket.**
   After internal-transfer deposits, the funds backing part of `currentDeposit` live in
   `allocatedBalances[solverSubAccount]` on Symmio, not as ERC20 anywhere the vault controls. If
   a withdrawer requests funds, the Balancer must source the ERC20 (it always could, via
   `acceptWithdrawRequest`'s `safeTransferFrom` from itself), but the *economic* backing of those
   funds is the solver's allocated balance — which the solver is actively trading and which can
   move with PnL. So the collateral total the Balancer can readily marshal may not cover the
   allocated bucket at a given moment. `p1-t3` investigates the magnitude and the operational
   mitigation (e.g. limits, periodic deallocate-back-to-vault, monitoring).

Neither of these requires a contract change in `p1-t2`; both are flagged here so the
implementation and the indexer/runbook owners know the contract intentionally relies on
event-driven crediting and out-of-band Balancer funding.

---

## 7. Attack surface

- **Caller impersonation / `depositor` spoofing.** Mitigated by step 2 (`owners(subAccount) ==
  _msgSender()`). Without it, any address could trigger a deposit from any sub-account that has an
  outstanding delegation to the vault, and the `Deposit` event would carry the attacker's address
  as `depositor` (so the indexer would credit the wrong user) — and a griefer could force a user's
  funds out of their sub-account into the solver's allocated balance before the user is ready.
- **Front-running the `_call` / partial transfer.** Mitigated by steps 3+5 (snapshot the
  destination allocated balance, then assert the delta is exactly `amount`). If anything other
  than exactly our `amount` lands, the tx reverts and `currentDeposit` is untouched.
- **Reentrancy.** `nonReentrant` (same as `deposit()`). The external surface touched is
  MultiAccount → sub-account → Symmio Diamond, all trusted, but the guard is kept for parity and
  defence-in-depth. State writes (`currentDeposit += amount`) happen after the external call;
  combined with `nonReentrant` and the strict delta assertion, this is safe.
- **Stale delegation.** A user who proposed-to-revoke but hasn't completed `revokeAccesses` on
  MultiAccount still has `delegatedAccesses == true`, so a deposit can still go through. This is
  upstream behaviour; the vault surfaces the upstream revert verbatim once the revoke actually
  lands. Combined with step 2 (only the owner can call), the only "victim" of a still-live
  delegation is the owner themselves calling intentionally. Documented, no vault mitigation.
- **Misconfigured `solverSubAccount` / `multiAccount`.** Zero-address is checked (step 1). A
  wrong-but-nonzero `solverSubAccount` would route funds to the wrong allocated bucket — same
  trust assumption as the existing `solver` setter; both are `SETTER_ROLE`-gated and event-emitting,
  so a misconfiguration is detectable on-chain.
- **Pause bypass.** `whenNotPaused` on the vault function, plus MultiAccount's own pause, plus
  Symmio's `whenNotInternalTransferPaused` / global pause — three independent kill switches.
- **DoS via `bytes[]`.** We always pass a length-1 array; no batching surface.
- **Decimal mismatch.** If `amount` is passed to `internalTransfer` in the wrong decimal base,
  the step-5 assertion catches it (the delta won't equal `amount`) and the tx reverts — fail-safe,
  not fail-open. (Still: the implementation must get the scaling right; see §5 step 4.)

---

## 8. Revert taxonomy

Categorised by where the revert originates. The vault must **not** wrap `multiAccount._call` in
try/catch — MultiAccount and Symmio reverts bubble up verbatim.

### Vault-side reverts (the caller's tx fails before/around the `_call`)

| # | Condition | Origin |
|---|-----------|--------|
| V1 | Vault paused | `whenNotPaused` modifier |
| V2 | `multiAccount == address(0)` | `require(..., "SymmioSolverDepositor: Zero address")` (step 1) |
| V3 | `solverSubAccount == address(0)` | `require(..., "SymmioSolverDepositor: Zero address")` (step 1) |
| V4 | `amount == 0` | `require(..., "SymmioSolverDepositor: Amount must be greater than 0")` (step 1; same string as `deposit()`) |
| V5 | `currentDeposit + amount > depositLimit` | `require(..., "SymmioSolverDepositor: Deposit limit reached")` (step 1; same string as `deposit()`) |
| V6 | `_msgSender() != multiAccount.owners(subAccount)` | `require(..., "SymmioSolverDepositor: Not subAccount owner")` (step 2) |
| V7 | `newAllocated - oldAllocated != amount` (or underflow) | `require(..., "SymmioSolverDepositor: Allocated balance mismatch")` (step 5) |
| V8 | Reentrant call | `nonReentrant` modifier |

### MultiAccount-side reverts (we never reach Symmio)

| # | Condition | Origin |
|---|-----------|--------|
| M1 | MultiAccount paused | MultiAccount `whenNotPaused` on `_call` |
| M2 | `delegatedAccesses[subAccount][vault][internalTransferSelector] == false` (never granted, revoked, or proposed-then-revoked) | MultiAccount `_call` authorisation check — reverts `"MultiAccount: Unauthorized access"` |
| M3 | Malformed call data (length < 4) | MultiAccount `_call` length check |

### Symmio-side reverts (the call reaches the Diamond and is rejected)

| # | Condition | Origin |
|---|-----------|--------|
| S-pause | `internalTransferPaused` / `globalPaused` / `accountingPaused` on the Diamond | Symmio `whenNotInternalTransferPaused` modifier |
| S-balance | `subAccount` deposited balance `< amount` | Symmio `internalTransfer` impl — insufficient deposited balance |
| S-suspend-from | `subAccount` (the signer) is suspended | Symmio `notSuspended(signer)` |
| S-suspend-to | `solverSubAccount` (recipient) is suspended | Symmio `notSuspended(user)` |
| S-partyB | `solverSubAccount` is registered as a PartyB | Symmio `userNotPartyB(user)` |
| S-liq | `solverSubAccount` is currently being liquidated | Symmio `notLiquidatedPartyA(user)` |
| S-cap | `solverSubAccount` allocated balance + amount > Symmio's `balanceLimitPerUser` | Symmio `internalTransfer` impl per-user cap |

(Exact Symmio revert strings/selectors are whatever the deployed Arbitrum Diamond emits; the
vault propagates them unchanged. The implementation/test task should snapshot the real strings in
a fork test.)

---

## 9. Tests the implementation task should add (`p1-t2`)

Hardhat (`npx hardhat test`), against forked Arbitrum or with mocked `IMultiAccount` / `ISymmio`:

- **Happy path:** with delegation in place and sufficient deposited balance, a call by the
  sub-account owner increments `currentDeposit` by `amount`, leaves the vault's ERC20 balance
  unchanged, emits `Deposit(owner, amount)` and `DepositViaInternalTransfer(owner, subAccount, amount)`,
  and increases `allocatedBalanceOfPartyA(solverSubAccount)` by `amount`.
- **Owner check:** a non-owner calling reverts `"SymmioSolverDepositor: Not subAccount owner"`,
  even when a delegation exists.
- **Amount/limit guards:** `amount == 0` reverts; `currentDeposit + amount > depositLimit` reverts;
  both with the same strings as `deposit()`.
- **Config guards:** with `solverSubAccount` or `multiAccount` unset, reverts `"SymmioSolverDepositor: Zero address"`.
- **Front-run guard:** a mocked MultiAccount/Symmio that moves a different amount (or nothing)
  makes the call revert `"SymmioSolverDepositor: Allocated balance mismatch"` and leaves
  `currentDeposit` unchanged.
- **Delegation missing/revoked:** reverts with the upstream `"MultiAccount: Unauthorized access"`
  (verbatim, not wrapped).
- **Paused:** vault paused → `whenNotPaused` revert.
- **Setters:** `setMultiAccount` / `setSolverSubAccount` revert for non-`SETTER_ROLE` callers,
  revert on zero address, and emit `MultiAccountUpdatedEvent` / `SolverSubAccountUpdatedEvent`.
- **Upgrade-layout regression:** an OZ upgrades-plugin storage-layout check (or a manual slot
  assertion) confirming the new variables are appended after `usedNonces`.
- **Invariant:** `currentDeposit == Σ(deposit amounts) + Σ(depositViaInternalTransfer amounts) − Σ(accepted withdraw amounts)`.

---

## Open questions / spec ambiguities surfaced while writing this

1. **`amount` decimals into `internalTransfer`.** The existing `deposit()` passes collateral-decimal
   `amount` to `symmio.depositFor`. Symmio's `internalTransfer` may expect 18-decimal input (and
   log a collateral-decimal value in its event). The implementation task must confirm against the
   deployed Arbitrum Diamond and scale if needed; the step-5 delta assertion must compare against
   the same unit `allocatedBalanceOfPartyA` reports. Flagged, not resolved here.
2. **`INTERNAL_TRANSFER_SELECTOR` exact signature.** Assumed `internalTransfer(address,uint256)`.
   The implementation task should verify against the deployed Arbitrum Diamond ABI.
3. **Should `multiAccount` / `solverSubAccount` be `initialize` params?** Not required — they
   default to zero and the function reverts until set. Left to the implementer; if added, append
   them (don't reorder existing params) and keep them optional in deploy scripts.
4. **Storage gap.** This contract has no `__gap`. Adding new appended vars is upgrade-safe without
   one; introducing a gap is a separate, orthogonal hardening change and is out of scope for `p1-t2`.
5. **`p1-t3` dependency.** The two break-modes in §6 (anti-spoof ERC20-inflow guard; Balancer
   collateral coverage of the allocated bucket) are explicitly punted to `p1-t3` and may feed back
   constraints (e.g. a separate per-path limit) — but none of those would change the contract
   surface defined here. **Resolved in §10 below.**

---

## 10. Off-chain accounting verification (p1-t3)

**Verdict: the new `depositViaInternalTransfer` path does NOT silently break the off-chain
accounting.** Neither of the two break-modes from §6 is present in the off-chain code on this
machine. One small observability nit (not a correctness issue) is noted at the end.

### Repos / files inspected

The off-chain side of this vault lives in two repos (read-only here):

- **`real-time-intentx-indexer`** (`/Users/sergio/IntentX/Intentx-Carbon/real-time-intentx-indexer/`)
  — Kafka-fed log decoder; persists vault on-chain events to Mongo. It does **not** credit users.
  - `src/pipeline.ts:83-103` — `vaultLifecycleEventNames` = `{Deposit, DepositToSymmio,
    WithdrawRequestEvent, WithdrawRequestAcceptedEvent, WithdrawRequestRejected,
    WithdrawRequestCanceled, WithdrawClaimedEvent}`; `isVaultLifecycleEvent` matches purely by
    `(contractAddress == vaultAddress) && name ∈ that set` — no ERC20 `Transfer` correlation.
  - `src/pipeline.ts:415-429` — vault-lifecycle logs are routed straight to
    `mongoWriter.writeVaultOnchainEvents(events)`.
  - `src/writers/mongo-writer.ts:1067-1153` — `writeVaultOnchainEvents` just transforms+upserts the
    decoded event (`account = depositor || sender || receiver`, `amount = eventData.amount`); no
    cross-check against an ERC20 inflow, no balance reconciliation.
- **`nox-vault-calculator-backend`** (`/Users/sergio/IntentX/Intentx-Carbon/solver-research/nox-vault-calculator-backend/`)
  — reads those persisted events from Mongo and projects per-user state (mints/burns LP units).
  This is the component that actually "credits a user". Identical copy also at
  `/Users/sergio/IntentX/solver-research/nox-vault-calculator-backend/` (only the dashboard
  controller differs); the `Intentx-Carbon` copy is the newer commit.
  - `src/modules/nox-vault/onchain/onchain-symmio-vault-v2.events.ts:8-225` — vault event ABI /
    topic table. Only `Deposit(address,uint256)` and the withdraw-lifecycle events are decoded;
    `DepositToSymmio` is decoded but unused; **no ERC20 `Transfer` ABI is involved at all**.
  - `src/modules/nox-vault/onchain/vault-onchain-to-stream.mapper.ts:13-28` — `case "Deposit"`:
    emits `{ type: "DEPOSIT", userId: depositor, amount, collateralAmount: amount }` directly from
    the event payload, gated only by `amount > 0`. `case "DepositToSymmio"` → returns `null`
    (explicitly "do not treat as LP/user deposit"). There is no path here that requires a matching
    `Transfer` into the vault, and nothing reads the vault's on-chain ERC20 `balanceOf` or
    `currentDeposit` to validate the credit.
  - `src/modules/nox-vault/onchain/vault-onchain-indexing.service.ts:98-105` — `case "DEPOSIT":`
    → `noxVault.emitDeposit(stream.userId, stream.collateralAmount ?? stream.amount)`.
  - `src/modules/nox-vault/nox-vault.service.ts:30-36` → `vaultService.deposit(userId, amount)`
    mints LP. `solverBalance` in `core/Vault.ts` / `core/VaultService.ts` is a *bookkeeping*
    figure incremented by these `deposit()` calls — it is never reconciled against an on-chain
    read. `grep` for `balanceOf` / `getCollateral` / `allocatedBalanceOfPartyA` / `reconcil` across
    `nox-vault-calculator-backend/src` finds only `getCollateralPerLp()` (`= solverBalance /
    totalLpSupply`, unrelated) and mock-only "solver state" simulation helpers in `VaultService.ts`
    — no production code reads Symmio balances.

(There is no separate `signer` service in any repo on this machine — the EIP-712 `WithdrawRequest`
signature consumed by `OnChainSymmioVaultV2.requestWithdraw` is produced elsewhere/not checked out
here. That is irrelevant to the two break-modes: `requestWithdraw` authorises *withdrawals*, and
internal-transfer deposits don't touch it. The `BALANCER_PRIVATE_KEY` in
`nox-vault-calculator-backend/src/contracts/onChainSymmioVaultV2/client.ts` is the *balancer* key
that submits `acceptWithdrawRequest` / `rejectWithdrawRequest`, not the vault `signer`.)

### Break-mode 1 — anti-spoof / ERC20-inflow guard on the indexer: NOT PRESENT → no change needed

The deposit-credit chain is, end to end:

```
on-chain  Deposit(depositor, amount)
  → real-time-intentx-indexer  (pipeline.ts → mongo-writer.ts)  persists the decoded event, no Transfer correlation
  → nox-vault-calculator-backend  vault-onchain-to-stream.mapper.ts  Deposit → { type: DEPOSIT, userId: depositor, amount }
  → vault-onchain-indexing.service.ts  DEPOSIT → noxVault.emitDeposit(depositor, amount)
  → nox-vault.service.ts → VaultService.deposit(userId, amount)  mints LP for `depositor`
```

Nothing in that chain requires (a) a matching ERC20 `Transfer` into the vault in the same tx, (b)
a `DepositToSymmio` co-event, or (c) any reconciliation of credited totals against the vault's
on-chain ERC20 `balanceOf` / `currentDeposit`. So `depositViaInternalTransfer` — which emits the
same `Deposit(_msgSender(), amount)` with **no ERC20 inflow to the vault** — is credited to the
caller EOA automatically, exactly like the wallet `deposit()` path. **No indexer change is required
for crediting to work.**

> Observability nit (not a correctness fix, owner: indexer/carbon team): the new
> `DepositViaInternalTransfer(address indexed depositor, address indexed subAccount, uint256
> amount)` event is *not* in the indexer's event tables
> (`onchain-symmio-vault-v2.events.ts` `EVENT_SIGNATURES` / `onChainSymmioVaultV2EventAbi`, and
> `pipeline.ts` `vaultLifecycleEventNames` / `mongo-writer.ts` `VAULT_EVENT_NAMES`), so it is
> currently dropped as an unknown topic. Crediting is unaffected (the co-emitted `Deposit` carries
> everything needed), but if path attribution / "which sub-account funded this" is wanted in the
> dashboard, add `DepositViaInternalTransfer(address,address,uint256)` to those tables (decode
> only — map it to `null` in `vault-onchain-to-stream.mapper.ts` so it does **not** also emit a
> second `DEPOSIT` stream event and double-credit).

### Break-mode 2 — Balancer "collateral I control" total covering the allocated bucket: N/A (no such figure exists in code)

The on-chain `acceptWithdrawRequest` funds payouts by pulling ERC20 from the balancer's *own EOA*
(`OnChainSymmioVaultV2.acceptWithdrawRequest` → `IERC20(collateralTokenAddress).safeTransferFrom(_msgSender(),
address(this), providedAmount)` — `contracts/OnChainSymmioVaultV2.sol:193`), and the off-chain
auto-accept just mirrors the requested amount (`withdrawal-auto-accept.service.ts:101-105`:
`providedAmount = req.requestedAmount`, `acceptedAmounts = [req.requestedAmount]`). There is **no
"collateral I control" / "vault backing" figure in the off-chain code on this machine** that reads
the solver's Symmio balances at all — not the legacy `solver` *available* bucket and not the new
`solverSubAccount` *allocated* bucket. So there is nothing to "extend to include the allocated
bucket": the figure doesn't exist to under-count. The only consequence of the new path is the one
already stated in §6.2 — the vault's local ERC20 balance no longer scales with `currentDeposit`,
which is a quantitative shift in balancer ops (the balancer must keep enough ERC20 in its wallet),
not a code bug.

**Recommendation (owner: balancer-ops / monitoring, NOT a blocker for `p1-t2`):** if/when a
"vault backing coverage" monitor or dashboard figure is built, its "collateral backing
`currentDeposit`" total must be
`vaultERC20.balanceOf(vault) + symmio.getCollateral-deposited-for(solver) + symmio.allocatedBalanceOfPartyA(solverSubAccount)`
(the third term is the new bucket). Until such a monitor exists there is no code to change; this is
a runbook item, consistent with §6.2's note that "it should be in the Balancer runbook".

### Bottom line for `p1-t2` / `p1-t3`

No off-chain code change is required for the internal-transfer deposit path to credit users
correctly or for the balancer to settle their withdrawals. The two follow-ups above
(`DepositViaInternalTransfer` decoding for observability; a "vault backing coverage" monitor that
includes `allocatedBalanceOfPartyA(solverSubAccount)`) are optional hardening for the indexer and
balancer-ops teams respectively, neither blocking nor changing the contract surface in §3–§5.
