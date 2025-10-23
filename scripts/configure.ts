import {ethers, run, upgrades} from "hardhat"

async function main() {
	const [deployer] = await ethers.getSigners()

	console.log("Deploying contracts with the account:", deployer.address)

	const Vault = await ethers.getContractAt("OnChainSymmioVault", "0x7785fE35F6510D111063579AA14F7D28aD84512A")
	await Vault.setDepositLimit(200000e6, 200000e6);

	await Vault.grantRole(await Vault.SETTER_ROLE(), deployer);

	const SymmioVaultLpToken = await ethers.getContractAt("SymmioVaultLpToken", "0xB6d340Af68279326402139C30934317929535D32")
	await SymmioVaultLpToken.grantRole("0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6", Vault)
	
	await Vault.grantRole(await Vault.BALANCER_ROLE(), "0x6b3535Be4eE1c383Bdc4e27f368971Deb1B4c485");
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error)
		process.exit(1)
	})
