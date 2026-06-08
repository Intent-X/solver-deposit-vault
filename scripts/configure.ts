import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Configuring SolverVault with the account:", deployer.address);

  const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
  if (!VAULT_ADDRESS) {
    throw new Error("Please provide VAULT_ADDRESS environment variable");
  }

  const vault = await ethers.getContractAt("SolverVault", VAULT_ADDRESS);

  const EXECUTOR = process.env.EXECUTOR;
  const REBALANCER = process.env.REBALANCER;
  const SIGNER = process.env.SIGNER;
  const SETTER = process.env.SETTER;
  const WHITELIST = process.env.WHITELIST; // comma-separated list of addresses to whitelist

  if (EXECUTOR) {
    await (await vault.grantRole(await vault.EXECUTOR_ROLE(), EXECUTOR)).wait();
    console.log("Granted EXECUTOR_ROLE to", EXECUTOR);
  }
  if (REBALANCER) {
    await (
      await vault.grantRole(await vault.REBALANCER_ROLE(), REBALANCER)
    ).wait();
    console.log("Granted REBALANCER_ROLE to", REBALANCER);
  }
  if (SIGNER) {
    await (await vault.grantRole(await vault.SIGNER_ROLE(), SIGNER)).wait();
    console.log("Granted SIGNER_ROLE to", SIGNER);
  }
  if (SETTER) {
    await (await vault.grantRole(await vault.SETTER_ROLE(), SETTER)).wait();
    console.log("Granted SETTER_ROLE to", SETTER);
  }
  if (WHITELIST) {
    for (const account of WHITELIST.split(",")
      .map((a) => a.trim())
      .filter(Boolean)) {
      await (await vault.setWhitelist(account, true)).wait();
      console.log("Whitelisted", account);
    }
  }

  console.log("✅ Configuration complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
