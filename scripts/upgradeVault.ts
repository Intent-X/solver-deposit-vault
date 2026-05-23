import { ZeroAddress } from "ethers"
import hre from "hardhat"

import { erc1967 } from "../utils/upgrades-shim.js"

const VAULT_PROXY = "0x7785fE35F6510D111063579AA14F7D28aD84512A"

async function main() {
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection
	;(hre as any).ethers = ethers

	const [deployer] = await ethers.getSigners()

	console.log("Deploying contracts with the account:", deployer.address)

	const Factory = await ethers.getContractFactory("SolverVault")
	const implementation = await Factory.deploy()
	await implementation.waitForDeployment()
	const implementationAddress = await implementation.getAddress()

	const contract = await ethers.getContractAt("SolverVault", VAULT_PROXY)
	const previousImplementation = await erc1967(hre).getImplementationAddress(VAULT_PROXY)
	const proxyAdmin = await erc1967(hre).getAdminAddress(VAULT_PROXY)

	let tx
	if (proxyAdmin === ZeroAddress) {
		tx = await contract.upgradeTo(implementationAddress)
	} else {
		const admin = await ethers.getContractAt(
			["function owner() view returns (address)", "function upgrade(address proxy, address implementation)"],
			proxyAdmin,
		)
		const adminOwner = await admin.owner()
		if (adminOwner.toLowerCase() !== deployer.address.toLowerCase()) {
			throw new Error(`ProxyAdmin owner ${adminOwner} does not match deployer ${deployer.address}`)
		}
		tx = await admin.upgrade(VAULT_PROXY, implementationAddress)
	}
	await tx.wait()

	const addresses = {
		proxy: VAULT_PROXY,
		proxyAdmin,
		previousImplementation,
		implementation: await erc1967(hre).getImplementationAddress(VAULT_PROXY),
	}
	console.log(addresses)
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error)
		process.exit(1)
	})
