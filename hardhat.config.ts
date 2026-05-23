import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers"
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import hardhatVerify from "@nomicfoundation/hardhat-verify"
import { config as dotenvConfig } from "dotenv"
import { configVariable, defineConfig } from "hardhat/config"
import { resolve } from "node:path"

const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
dotenvConfig({ path: resolve(process.cwd(), dotenvConfigPath) })

const useKeystore = process.env.USE_KEYSTORE === "true"
const privateKey = process.env.PRIVATE_KEY || (useKeystore ? configVariable("PRIVATE_KEY") : undefined)
const baseApiKey = process.env.BASE_API_KEY || (useKeystore ? configVariable("BASE_API_KEY") : "")
const baseRpc = process.env.RPC_BASE || (useKeystore ? configVariable("RPC_BASE") : "https://mainnet.base.org") || "https://mainnet.base.org"

export default defineConfig({
	plugins: [hardhatToolboxMochaEthers, hardhatEthersPlugin, hardhatVerify],
	solidity: {
		profiles: {
			default: {
				version: "0.8.28",
				settings: {
					evmVersion: "shanghai",
					optimizer: {
						enabled: true,
						runs: 2048,
					},
				},
			},
			production: {
				version: "0.8.28",
				settings: {
					evmVersion: "shanghai",
					optimizer: {
						enabled: true,
						runs: 2048,
					},
				},
			},
		},
	},
	networks: {
		default: {
			type: "edr-simulated",
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: false,
			hardfork: "shanghai",
		},
		base: {
			type: "http",
			chainId: 8453,
			url: baseRpc,
			accounts: privateKey === undefined ? [] : [privateKey],
		},
	},
	verify: {
		etherscan: {
			apiKey: baseApiKey,
		},
	},
	paths: {
		artifacts: "./artifacts",
		cache: "./cache",
		sources: "./contracts",
		tests: "./test",
	},
	typechain: {
		outDir: resolve(process.cwd(), "src/types"),
	},
})
