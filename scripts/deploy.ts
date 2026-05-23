import hre from "hardhat"

async function main() {
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection

	const symmio = process.env.SYMMIO_ADDRESS
	const vault = process.env.VAULT_ADDRESS
	if (!symmio || !vault) {
		throw new Error("Please set SYMMIO_ADDRESS and VAULT_ADDRESS")
	}

	const Contract = await ethers.getContractFactory("SolverVaultRelayer")
	const contract = await Contract.deploy(symmio, vault)
	await contract.waitForDeployment()
	console.log(`${contract} deployed: ${await contract.getAddress()}`)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
