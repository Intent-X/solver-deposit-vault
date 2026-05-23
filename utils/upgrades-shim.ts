import ERC1967ProxyArtifact from "@openzeppelin/contracts/build/contracts/ERC1967Proxy.json" with { type: "json" }
import { ethers } from "ethers"
import type { ContractFactory } from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"

type DeployProxyOptions = {
	initializer?: string | false
	kind?: "erc1967"
}

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

async function readAddressSlot(hre: HardhatRuntimeEnvironment, address: string, slot: string): Promise<string> {
	const value = await (hre as any).ethers.provider.getStorage(address, slot)
	return ethers.getAddress("0x" + value.slice(26))
}

export const erc1967 = (hre: HardhatRuntimeEnvironment) => ({
	getImplementationAddress: (address: string) => readAddressSlot(hre, address, IMPLEMENTATION_SLOT),
	getAdminAddress: (address: string) => readAddressSlot(hre, address, ADMIN_SLOT),
})

export async function deployProxy(hre: HardhatRuntimeEnvironment, factory: ContractFactory, args: unknown[] = [], options: DeployProxyOptions = {}) {
	const initializer = options.initializer === undefined ? "initialize" : options.initializer
	const [defaultSigner] = await (hre as any).ethers.getSigners()

	const implementation = await factory.deploy()
	await implementation.waitForDeployment()

	let initData = "0x"
	if (initializer !== false) {
		initData = factory.interface.encodeFunctionData(initializer, args)
	}

	const { abi, bytecode } = ERC1967ProxyArtifact as any
	const ProxyFactory = new (hre as any).ethers.ContractFactory(abi, bytecode, defaultSigner)
	const proxy = await ProxyFactory.deploy(await implementation.getAddress(), initData)

	await proxy.waitForDeployment()
	return factory.attach(await proxy.getAddress())
}
