import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

async function main() {
  const connection = await hre.network.getOrCreate();
  const { ethers } = connection;
  const upgradesApi = await upgrades(hre, connection);

  const [deployer] = await ethers.getSigners();
  console.log("Upgrading SolverVault with the account:", deployer.address);

  const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
  if (!VAULT_ADDRESS) {
    throw new Error("Please provide VAULT_ADDRESS environment variable");
  }

  const Factory = await ethers.getContractFactory("SolverVault");
  const contract = await upgradesApi.upgradeProxy(VAULT_ADDRESS, Factory, {});
  await contract.waitForDeployment();

  const proxy = await contract.getAddress();
  const addresses = {
    proxy,
    admin: await upgradesApi.erc1967.getAdminAddress(proxy),
    implementation: await upgradesApi.erc1967.getImplementationAddress(proxy),
  };
  console.log(addresses);

  try {
    console.log("Verifying contract...");
    await new Promise((r) => setTimeout(r, 15000));
    await hre.tasks
      .getTask("verify")
      .run({ address: addresses.implementation });
    console.log("Contract verified!");
  } catch (e) {
    console.log(e);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
