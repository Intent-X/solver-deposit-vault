import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

async function main() {
  const connection = await hre.network.getOrCreate();
  const { ethers } = connection;
  const upgradesApi = await upgrades(hre, connection);

  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  const ADMIN = process.env.ADMIN || deployer.address;
  const COLLATERAL_TOKEN =
    process.env.COLLATERAL_TOKEN ||
    "0x91Cf2D8Ed503EC52768999aA6D8DBeA6e52dbe43";

  const Factory = await ethers.getContractFactory("SolverVault");
  const contract = await upgradesApi.deployProxy(
    Factory,
    [
      ADMIN, // admin (gets DEFAULT_ADMIN_ROLE + SETTER_ROLE)
      COLLATERAL_TOKEN, // collateral token
    ],
    { initializer: "initialize" }
  );
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
