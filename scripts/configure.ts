import hre from "hardhat"

async function main() {
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection

	const [deployer] = await ethers.getSigners()

	console.log("Deploying contracts with the account:", deployer.address)

	const Vault = await ethers.getContractAt("SolverVault", "0x7785fE35F6510D111063579AA14F7D28aD84512A")
	await Vault.setDepositLimit(200000e6)

	await Vault.grantRole(await Vault.SETTER_ROLE(), deployer)

	await Vault.grantRole(await Vault.BALANCER_ROLE(), "0x6b3535Be4eE1c383Bdc4e27f368971Deb1B4c485")
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error)
		process.exit(1)
	})
