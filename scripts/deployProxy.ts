import hre from "hardhat"

import { deployProxy, erc1967 } from "../utils/upgrades-shim.js"

async function main() {
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection
	;(hre as any).ethers = ethers

	const [deployer] = await ethers.getSigners()

	console.log("Deploying contracts with the account:", deployer.address)

	const Factory = await ethers.getContractFactory("SolverVault")
	const contract = await deployProxy(
		hre,
		Factory,
		[
			"0x91Cf2D8Ed503EC52768999aA6D8DBeA6e52dbe43", //_symmioAddress
			"0xB49Cae38c96f6425Ce4A46e8220549C6a13362bE", //_solver or _broker
			deployer.address, //_balancer
			deployer.address, //_multisig
		],
		{ kind: "erc1967", initializer: "initialize" },
	)

	await contract.waitForDeployment()

	const addresses = {
		proxy: await contract.getAddress(),
		implementation: await erc1967(hre).getImplementationAddress(await contract.getAddress()),
	}
	console.log(addresses)
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error)
		process.exit(1)
	})
