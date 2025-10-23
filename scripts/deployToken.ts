import {ethers, run, upgrades} from "hardhat"

async function main() {

	const [deployer] = await ethers.getSigners()

	console.log("Deploying contracts with the account:", deployer.address)

	const Factory = await ethers.getContractFactory("SymmioVaultLpToken")
	const contract = await upgrades.deployProxy(Factory, [
		6
	], {initializer: "initialize"})

	await contract.waitForDeployment()

	const addresses = {
		proxy: await contract.getAddress(),
		admin: await upgrades.erc1967.getAdminAddress(await contract.getAddress()),
		implementation: await upgrades.erc1967.getImplementationAddress(await contract.getAddress()),
	}
	console.log(addresses)

	try {
		console.log("Verifying contract...")
		await new Promise(r => setTimeout(r, 15000))
		await run("verify:verify", {address: await contract.getAddress()})
		console.log("Contract verified!")
	} catch (e) {
		console.log(e)
	}
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
