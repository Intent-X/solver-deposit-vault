import {ethers, run, upgrades} from "hardhat"

async function main() {
	const [deployer] = await ethers.getSigners()

	console.log("Deploying contracts with the account:", deployer.address)

	const Factory = await ethers.getContractFactory("OnChainSymmioVault")
    const contract = await upgrades.upgradeProxy("0x7785fE35F6510D111063579AA14F7D28aD84512A", Factory, {
    })

    await contract.waitForDeployment()

	const addresses = {
		proxy: await contract.getAddress(),
		admin: await upgrades.erc1967.getAdminAddress(await contract.getAddress()),
		implementation: await upgrades.erc1967.getImplementationAddress(await contract.getAddress()),
	}
	console.log(addresses)

	await contract.setWithdrawalPeriod(600);

	try {
		console.log("Verifying contract...")
		await new Promise(r => setTimeout(r, 15000))
		await run("verify:verify", {address: addresses.implementation})
		console.log("Contract verified!")
	} catch (e) {
		console.log(e)
	}
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error)
		process.exit(1)
	})
