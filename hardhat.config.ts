import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "ethers";
import { resolve } from "path";

import { config as dotenvConfig } from "dotenv";

const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "./.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

// Ensure that we have all the environment variables we need.
const privateKey: string | undefined = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error("Please set your PRIVATE_KEY in a .env file");
const wallet = new ethers.Wallet(privateKey);
if (wallet.address !== "0xf1d63df1CD64a3f3A8F440bAba619dbB4baBB020")
  console.warn(
    `Using wallet ${wallet.address} instead of original 0xf1d63df1CD64a3f3A8F440bAba619dbB4baBB020`
  );
const baseApiKey: string = process.env.BASE_API_KEY || "";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  gasReporter: {
    currency: "USD",
    enabled: true,
    excludeContracts: [],
    src: "./contracts",
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
    },
    base: {
      url: "https://1rpc.io/base",
      accounts: [privateKey || `0x0`],
    },
  },
  etherscan: {
    apiKey: {
      base: baseApiKey,
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: `https://api.basescan.org/api?apiKey=${baseApiKey}`,
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
  },
    solidity: {
    compilers: [
      {
        version: "0.8.18",
        settings: {
          optimizer: {
            enabled : true,
            runs: 2048,
          }
        }
      },
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled : true,
            runs: 2048,
          }
        }
      },
    ]
    },
};

export default config;
