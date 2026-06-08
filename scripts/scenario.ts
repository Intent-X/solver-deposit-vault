/**
 * Full end-to-end scenario for the SolverVault on a local Hardhat network.
 *
 * It deploys a mock collateral token (6 decimals, USDC-like) plus the upgradeable
 * SolverVault behind a proxy, wires up every role, and then walks through a
 * realistic lifecycle:
 *
 *   1. Three users deposit collateral.
 *   2. A user requests a withdrawal (signed by the SIGNER) -> executor ACCEPTS.
 *   3. A second user requests a withdrawal             -> executor REJECTS.
 *   4. A third user requests a withdrawal              -> user CANCELS it.
 *   5. The rebalancer moves idle funds to whitelisted treasuries
 *      (SYMM / Buffer Pool / Vittaverse, 30/20/50 split from the spec).
 *   6. Pause / unpause is exercised.
 *
 * Each step asserts the resulting accounting so the script doubles as an
 * integration test. Run with:
 *
 *   npx hardhat run scripts/scenario.ts
 */
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import type { Signer } from "ethers";

const DECIMALS = 6n;
const ONE = 10n ** DECIMALS;

function usdc(n: number | bigint): bigint {
  return BigInt(n) * ONE;
}

function fmt(amount: bigint): string {
  const whole = amount / ONE;
  const frac = (amount % ONE).toString().padStart(Number(DECIMALS), "0");
  return `${whole}.${frac}`;
}

let checks = 0;
function check(
  label: string,
  actual: bigint | boolean,
  expected: bigint | boolean,
  raw = false
) {
  checks++;
  const ok = actual === expected;
  const status = ok ? "PASS" : "FAIL";
  const show = (v: bigint | boolean) =>
    typeof v === "bigint" ? (raw ? v.toString() : fmt(v)) : String(v);
  const fa = show(actual);
  const fe = show(expected);
  console.log(`   [${status}] ${label} -> got ${fa}, expected ${fe}`);
  if (!ok) {
    throw new Error(`Assertion failed: ${label} (got ${fa}, expected ${fe})`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const connection = await hre.network.getOrCreate();
  const { ethers } = connection;
  const upgradesApi = await upgrades(hre, connection);

  const signers = await ethers.getSigners();
  const [
    admin,
    executor,
    rebalancer,
    signer,
    setter,
    user1,
    user2,
    user3,
    receiver,
    symmTreasury,
    bufferPool,
    vittaverse,
  ] = signers;

  const addr = async (s: Signer) => s.getAddress();

  // ----------------------------------------------------------------------------
  section("Deploy mock collateral + SolverVault proxy");
  // ----------------------------------------------------------------------------
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const collateral = await MockERC20.connect(admin).deploy(DECIMALS);
  await collateral.waitForDeployment();
  console.log("MockERC20 (collateral):", await collateral.getAddress());

  const SolverVault = await ethers.getContractFactory("SolverVault");
  const vault = await upgradesApi.deployProxy(
    SolverVault,
    [await addr(admin), await collateral.getAddress()],
    { initializer: "initialize" }
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("SolverVault proxy:        ", vaultAddress);
  console.log(
    "SolverVault implementation:",
    await upgradesApi.erc1967.getImplementationAddress(vaultAddress)
  );

  // ----------------------------------------------------------------------------
  section("Grant roles + whitelist treasuries");
  // ----------------------------------------------------------------------------
  await vault
    .connect(admin)
    .grantRole(await vault.EXECUTOR_ROLE(), await addr(executor));
  await vault
    .connect(admin)
    .grantRole(await vault.REBALANCER_ROLE(), await addr(rebalancer));
  await vault
    .connect(admin)
    .grantRole(await vault.SIGNER_ROLE(), await addr(signer));
  await vault
    .connect(admin)
    .grantRole(await vault.SETTER_ROLE(), await addr(setter));
  console.log("Granted EXECUTOR / REBALANCER / SIGNER / SETTER roles");

  for (const [name, who] of [
    ["SYMM", symmTreasury],
    ["BufferPool", bufferPool],
    ["Vittaverse", vittaverse],
  ] as const) {
    await vault.connect(setter).setWhitelist(await addr(who), true);
    console.log(`Whitelisted ${name}:`, await addr(who));
  }

  // EIP-712 signing helper (mirrors the contract's WITHDRAW_TYPEHASH).
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "SolverVault",
    version: "1",
    chainId,
    verifyingContract: vaultAddress,
  };
  const types = {
    WithdrawRequest: [
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  async function signWithdraw(
    user: string,
    amount: bigint,
    rec: string,
    nonce: bigint,
    deadline: bigint
  ) {
    return signer.signTypedData(domain, types, {
      user,
      amount,
      receiver: rec,
      nonce,
      deadline,
    });
  }
  async function deadline(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp) + 3600n;
  }

  // ----------------------------------------------------------------------------
  section("Users deposit collateral");
  // ----------------------------------------------------------------------------
  const deposits: Array<[Signer, bigint]> = [
    [user1, usdc(1000)],
    [user2, usdc(500)],
    [user3, usdc(250)],
  ];
  for (const [u, amount] of deposits) {
    await collateral.connect(admin).mint(await addr(u), amount);
    await collateral.connect(u).approve(vaultAddress, amount);
    await vault.connect(u).deposit(amount);
    console.log(`Deposited ${fmt(amount)} for ${await addr(u)}`);
  }

  const totalDeposited = usdc(1750);
  check("totalDeposited", await vault.totalDeposited(), totalDeposited);
  check(
    "vault balance",
    await collateral.balanceOf(vaultAddress),
    totalDeposited
  );
  check(
    "depositedPerUser[user1]",
    await vault.depositedPerUser(await addr(user1)),
    usdc(1000)
  );

  // ----------------------------------------------------------------------------
  section("Withdrawal #0 -> ACCEPTED by executor");
  // ----------------------------------------------------------------------------
  {
    const amount = usdc(400);
    const rec = await addr(receiver);
    const nonce = 1n;
    const dl = await deadline();
    const sig = await signWithdraw(await addr(user1), amount, rec, nonce, dl);
    await vault.connect(user1).requestWithdraw(amount, rec, nonce, dl, sig);
    console.log(
      `user1 requested withdraw of ${fmt(amount)} -> receiver ${rec}`
    );
    check("pendingToWithdraw", await vault.pendingToWithdraw(), amount);

    await vault.connect(executor).acceptWithdrawRequest(0);
    console.log("executor accepted request #0");
    check("receiver balance", await collateral.balanceOf(rec), amount);
    check("totalWithdrawn", await vault.totalWithdrawn(), amount);
    check("pendingToWithdraw", await vault.pendingToWithdraw(), 0n);
    const req = await vault.withdrawRequests(0);
    check("request #0 status == Accepted(1)", req.status, 1n, true);
  }

  // ----------------------------------------------------------------------------
  section("Withdrawal #1 -> REJECTED by executor");
  // ----------------------------------------------------------------------------
  {
    const amount = usdc(200);
    const rec = await addr(user2);
    const nonce = 1n;
    const dl = await deadline();
    const sig = await signWithdraw(await addr(user2), amount, rec, nonce, dl);
    await vault.connect(user2).requestWithdraw(amount, rec, nonce, dl, sig);
    console.log(`user2 requested withdraw of ${fmt(amount)}`);
    check("pendingToWithdraw", await vault.pendingToWithdraw(), amount);

    await vault.connect(executor).rejectWithdrawRequest(1);
    console.log("executor rejected request #1");
    check("pendingToWithdraw", await vault.pendingToWithdraw(), 0n);
    const req = await vault.withdrawRequests(1);
    check("request #1 status == Rejected(2)", req.status, 2n, true);
  }

  // ----------------------------------------------------------------------------
  section("Withdrawal #2 -> CANCELED by the user");
  // ----------------------------------------------------------------------------
  {
    const amount = usdc(100);
    const rec = await addr(user3);
    const nonce = 1n;
    const dl = await deadline();
    const sig = await signWithdraw(await addr(user3), amount, rec, nonce, dl);
    await vault.connect(user3).requestWithdraw(amount, rec, nonce, dl, sig);
    console.log(`user3 requested withdraw of ${fmt(amount)}`);
    check("pendingToWithdraw", await vault.pendingToWithdraw(), amount);

    await vault.connect(user3).cancelWithdrawRequest(2);
    console.log("user3 canceled request #2");
    check("pendingToWithdraw", await vault.pendingToWithdraw(), 0n);
    const req = await vault.withdrawRequests(2);
    check("request #2 status == Canceled(3)", req.status, 3n, true);
  }

  // ----------------------------------------------------------------------------
  section(
    "Rebalance idle funds to treasuries (SYMM/Buffer/Vittaverse 30/20/50)"
  );
  // ----------------------------------------------------------------------------
  {
    const rebalanceTotal = usdc(1000);
    const symm = (rebalanceTotal * 30n) / 100n;
    const buffer = (rebalanceTotal * 20n) / 100n;
    const vitta = (rebalanceTotal * 50n) / 100n;

    const balanceBefore = await collateral.balanceOf(vaultAddress);
    console.log(`Vault balance before rebalance: ${fmt(balanceBefore)}`);

    await vault
      .connect(rebalancer)
      .rebalance(
        [
          await addr(symmTreasury),
          await addr(bufferPool),
          await addr(vittaverse),
        ],
        [symm, buffer, vitta]
      );
    console.log(
      `Rebalanced SYMM ${fmt(symm)} / Buffer ${fmt(buffer)} / Vittaverse ${fmt(
        vitta
      )}`
    );

    check(
      "SYMM balance",
      await collateral.balanceOf(await addr(symmTreasury)),
      symm
    );
    check(
      "Buffer balance",
      await collateral.balanceOf(await addr(bufferPool)),
      buffer
    );
    check(
      "Vittaverse balance",
      await collateral.balanceOf(await addr(vittaverse)),
      vitta
    );
    // rebalance must NOT touch the withdrawal accounting numbers.
    check("totalWithdrawn unchanged", await vault.totalWithdrawn(), usdc(400));
    check(
      "vault balance after rebalance",
      await collateral.balanceOf(vaultAddress),
      balanceBefore - rebalanceTotal
    );
  }

  // ----------------------------------------------------------------------------
  section("Pause / unpause");
  // ----------------------------------------------------------------------------
  {
    await vault.connect(setter).pause();
    check("paused", await vault.paused(), true);
    let blocked = false;
    try {
      await collateral.connect(admin).mint(await addr(user1), usdc(10));
      await collateral.connect(user1).approve(vaultAddress, usdc(10));
      await vault.connect(user1).deposit(usdc(10));
    } catch {
      blocked = true;
    }
    check("deposit blocked while paused", blocked, true);
    await vault.connect(setter).unpause();
    check("paused", await vault.paused(), false);
  }

  // ----------------------------------------------------------------------------
  section("Final accounting summary");
  // ----------------------------------------------------------------------------
  console.log("   totalDeposited:   ", fmt(await vault.totalDeposited()));
  console.log("   totalWithdrawn:   ", fmt(await vault.totalWithdrawn()));
  console.log("   pendingToWithdraw:", fmt(await vault.pendingToWithdraw()));
  console.log(
    "   vault balance:    ",
    fmt(await collateral.balanceOf(vaultAddress))
  );
  console.log(
    "   requests created: ",
    (await vault.withdrawRequestsLength()).toString()
  );

  console.log(`\nScenario complete — ${checks} checks passed.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
