import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatUpgrades from "@openzeppelin/hardhat-upgrades";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers, hardhatVerify, hardhatUpgrades],
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      metadata: {
        bytecodeHash: "none",
      },
      optimizer: {
        enabled: true,
        runs: 200000,
      },
      viaIR: true,
    },
  },
  networks: {
    // In-process EVM used for `hardhat test` and `hardhat run` without --network.
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
    },
    base: {
      type: "http",
      chainType: "l1",
      url: "https://1rpc.io/base",
      accounts: [configVariable("PRIVATE_KEY")],
    },
  },
  // hardhat-verify v3 uses Etherscan's unified (V2) multichain API; a single
  // Etherscan API key works for Base. Set ETHERSCAN_API_KEY in your env.
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
