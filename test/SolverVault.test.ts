import { expect } from "chai"
import { Signer, ZeroAddress } from "ethers"

import { deployProxy, erc1967 } from "../utils/upgrades-shim.js"
import { ethers, hre } from "./helpers/hardhat-connection.js"

function decimal(n: number, decimal: bigint = 18n): bigint {
	return BigInt(n) * 10n ** decimal
}

enum RequestStatus {
	Pending,
	Done,
	Canceled,
}

describe("SolverVault", function () {
	let solverVault: any, collateralToken: any, collateralToken2: any, symmio: any, symmioWithDifferentCollateral: any
	let owner: Signer,
		user: Signer,
		depositorUser: Signer,
		balancer: Signer,
		receiver: Signer,
		setter: Signer,
		pauser: Signer,
		unpauser: Signer,
		solver: Signer,
		other: Signer
	let collateralDecimals = 6n
	let BALANCER_ROLE: string, PAUSER_ROLE: string, UNPAUSER_ROLE: string, SETTER_ROLE: string, SYMMIO_RELAYER_ROLE: string
	const depositLimit = decimal(100000)

	async function mintFor(account: Signer, amount: bigint) {
		await collateralToken.connect(owner).mint(await account.getAddress(), amount)
		await collateralToken.connect(account).approve(await solverVault.getAddress(), amount)
	}

	beforeEach(async function () {
		;[owner, user, depositorUser, balancer, receiver, setter, pauser, unpauser, solver, other] = await ethers.getSigners()

		const SolverVaultFactory = await ethers.getContractFactory("SolverVault")
		const MockERC20 = await ethers.getContractFactory("MockERC20")
		const Symmio = await ethers.getContractFactory("MockSymmio")

		collateralToken = await MockERC20.connect(owner).deploy(collateralDecimals)
		await collateralToken.waitForDeployment()

		collateralToken2 = await MockERC20.connect(owner).deploy(collateralDecimals + 1n)
		await collateralToken2.waitForDeployment()

		symmio = await Symmio.deploy(await collateralToken.getAddress())
		await symmio.waitForDeployment()

		symmioWithDifferentCollateral = await Symmio.deploy(await collateralToken2.getAddress())
		await symmioWithDifferentCollateral.waitForDeployment()

		solverVault = (await deployProxy(
			hre,
			SolverVaultFactory,
			[await symmio.getAddress(), await solver.getAddress(), await owner.getAddress(), await owner.getAddress()],
			{ kind: "erc1967" },
		)) as any

		BALANCER_ROLE = await solverVault.BALANCER_ROLE()
		SETTER_ROLE = await solverVault.SETTER_ROLE()
		PAUSER_ROLE = await solverVault.PAUSER_ROLE()
		UNPAUSER_ROLE = await solverVault.UNPAUSER_ROLE()
		SYMMIO_RELAYER_ROLE = await (solverVault as any).SYMMIO_RELAYER_ROLE()

		await solverVault.connect(owner).grantRole(BALANCER_ROLE, await balancer.getAddress())
		await solverVault.connect(owner).grantRole(SETTER_ROLE, await owner.getAddress())
		await solverVault.connect(owner).grantRole(SETTER_ROLE, await setter.getAddress())
		await solverVault.connect(owner).grantRole(PAUSER_ROLE, await pauser.getAddress())
		await solverVault.connect(owner).grantRole(UNPAUSER_ROLE, await unpauser.getAddress())
	})

	describe("initialize", function () {
		it("should revert if initialize second time", async () => {
			await expect(
				solverVault.initialize(await symmio.getAddress(), await solver.getAddress(), await owner.getAddress(), await owner.getAddress()),
			).to.revert(ethers)
		})

		it("should set initial values correctly", async function () {
			expect(await solverVault.symmio()).to.equal(await symmio.getAddress())
			expect(await solverVault.solver()).to.equal(await solver.getAddress())
		})

		it("should reject zero balancer during initialization", async function () {
			const SolverVaultFactory = await ethers.getContractFactory("SolverVault")

			await expect(
				deployProxy(hre, SolverVaultFactory, [await symmio.getAddress(), await solver.getAddress(), ZeroAddress, await owner.getAddress()], {
					kind: "erc1967",
				}),
			).to.be.revertedWithCustomError(solverVault, "ZeroAddress")
		})

		it("should reject zero multisig during initialization", async function () {
			const SolverVaultFactory = await ethers.getContractFactory("SolverVault")

			await expect(
				deployProxy(hre, SolverVaultFactory, [await symmio.getAddress(), await solver.getAddress(), await owner.getAddress(), ZeroAddress], {
					kind: "erc1967",
				}),
			).to.be.revertedWithCustomError(solverVault, "ZeroAddress")
		})

		it("Should fail to update collateral", async () => {
			await expect(solverVault.connect(owner).setSymmioAddress(await symmioWithDifferentCollateral.getAddress())).to.be.revertedWithCustomError(
				solverVault,
				"CollateralCannotBeChanged",
			)
		})

		it("Should fail to set invalid solver", async () => {
			await expect(solverVault.connect(owner).setSolver(ZeroAddress)).to.be.revertedWithCustomError(solverVault, "ZeroAddress")
			await expect(solverVault.connect(other).setSolver(await solver.getAddress())).to.revert(ethers)
		})

		it("Should fail to set symmioAddress", async () => {
			await expect(solverVault.connect(owner).setSymmioAddress(ZeroAddress)).to.be.revertedWithCustomError(solverVault, "ZeroAddress")
			await expect(solverVault.connect(other).setSymmioAddress(await solver.getAddress())).to.revert(ethers)
		})

		it("Should fail to change collateral", async () => {
			await expect(solverVault.connect(setter).setSymmioAddress(await symmioWithDifferentCollateral.getAddress())).to.be.revertedWithCustomError(
				solverVault,
				"CollateralCannotBeChanged",
			)
		})

		it("Should pause/unpause with given roles", async () => {
			await solverVault.connect(pauser).pause()
			await solverVault.connect(unpauser).unpause()
			await expect(solverVault.connect(other).pause()).to.revert(ethers)
			await expect(solverVault.connect(other).unpause()).to.revert(ethers)
		})

		it("Should update deposit limit", async () => {
			await solverVault.connect(setter).setDepositLimit(1000)
			await expect(solverVault.connect(other).setDepositLimit(1000)).to.revert(ethers)
		})
	})

	describe("deposit", function () {
		const depositAmount = decimal(1, collateralDecimals)

		beforeEach(async function () {
			await mintFor(user, depositAmount)
		})

		it("should deposit tokens", async function () {
			let depositTx = await solverVault.connect(user).deposit(depositAmount)
			await expect(depositTx)
				.to.emit(solverVault, "Deposit")
				.withArgs(await user.getAddress(), depositAmount)
			await expect(depositTx)
				.to.emit(solverVault, "DepositToSymmio")
				.withArgs(await user.getAddress(), await solver.getAddress(), depositAmount)
			expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(0)
			expect(await symmio.balanceOf(await solver.getAddress())).to.equal(depositAmount)
			expect(await solverVault.currentDeposit()).to.equal(depositAmount)
			expect(await (solverVault as any).depositedBalances(await user.getAddress())).to.equal(depositAmount)
		})

		it("should fail when is paused", async function () {
			await solverVault.connect(pauser).pause()
			await expect(solverVault.connect(user).deposit(depositAmount)).to.revert(ethers)
		})

		it("should fail if transfer fails", async function () {
			await expect(solverVault.connect(other).deposit(depositAmount)).to.revert(ethers)
		})

		it("should fail to deposit more than limit", async function () {
			await expect(solverVault.connect(user).deposit(depositLimit + 1n)).to.be.revertedWithCustomError(solverVault, "DepositLimitReached")
		})

		it("should fail to deposit zero amount", async function () {
			await expect(solverVault.connect(user).deposit(0n)).to.be.revertedWithCustomError(solverVault, "AmountMustBeGreaterThanZero")
		})

		it("should update the current deposit amount", async function () {
			const onChainDepositLimit = await solverVault.depositLimit()
			const amount = onChainDepositLimit - depositAmount + 1n

			await solverVault.connect(user).deposit(depositAmount)

			await expect(solverVault.connect(other).deposit(amount)).to.be.revertedWithCustomError(solverVault, "DepositLimitReached")

			await solverVault.connect(user).requestWithdraw(depositAmount, 0, await owner.getAddress())
			await collateralToken.mint(await solverVault.getAddress(), depositAmount)
			await solverVault.connect(balancer).acceptWithdrawRequest(0, [0], [depositAmount])

			await mintFor(user, amount)
			await solverVault.connect(user).deposit(amount)

			expect(await solverVault.currentDeposit()).to.equal(amount)
		})
	})

	describe("depositFromSymmio", function () {
		const depositAmount = decimal(1, collateralDecimals)
		let relayer: any

		beforeEach(async function () {
			relayer = owner
			await solverVault.connect(owner).grantRole(SYMMIO_RELAYER_ROLE, await relayer.getAddress())
			await collateralToken.mint(await relayer.getAddress(), depositAmount)
			await collateralToken.connect(relayer).approve(await solverVault.getAddress(), depositAmount)
		})

		it("should deposit relayed Symmio collateral for the receiver", async function () {
			const depositTx = await (solverVault as any)
				.connect(relayer)
				.depositFromSymmio(await user.getAddress(), await depositorUser.getAddress(), depositAmount)

			await expect(depositTx)
				.to.emit(solverVault, "Deposit")
				.withArgs(await depositorUser.getAddress(), depositAmount)
			await expect(depositTx)
				.to.emit(solverVault, "DepositToSymmio")
				.withArgs(await depositorUser.getAddress(), await solver.getAddress(), depositAmount)
			await expect(depositTx)
				.to.emit(solverVault, "DepositFromSymmio")
				.withArgs(await user.getAddress(), await depositorUser.getAddress(), await relayer.getAddress(), depositAmount)

			expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(0)
			expect(await symmio.balanceOf(await solver.getAddress())).to.equal(depositAmount)
			expect(await solverVault.currentDeposit()).to.equal(depositAmount)
			expect(await (solverVault as any).depositedBalances(await depositorUser.getAddress())).to.equal(depositAmount)
			expect(await (solverVault as any).depositedBalances(await user.getAddress())).to.equal(0)
		})

		it("should reject direct calls from unauthorized accounts", async function () {
			await expect((solverVault as any).connect(other).depositFromSymmio(await user.getAddress(), await user.getAddress(), depositAmount)).to.revert(
				ethers,
			)
		})
	})

	describe("SolverVaultRelayer", function () {
		const depositAmount = decimal(1, collateralDecimals)
		let vaultRelayer: any

		beforeEach(async function () {
			const Relayer = await ethers.getContractFactory("SolverVaultRelayer")
			vaultRelayer = await Relayer.deploy(await symmio.getAddress(), await solverVault.getAddress())
			await vaultRelayer.waitForDeployment()

			await solverVault.connect(owner).grantRole(SYMMIO_RELAYER_ROLE, await vaultRelayer.getAddress())
		})

		it("should receive an external transfer and deposit it into the vault", async function () {
			await collateralToken.mint(await vaultRelayer.getAddress(), depositAmount)

			const depositTx = await symmio
				.connect(owner)
				.callExternalTransferRelayer(
					await vaultRelayer.getAddress(),
					await user.getAddress(),
					await depositorUser.getAddress(),
					depositAmount,
					await solverVault.getAddress(),
				)

			await expect(depositTx)
				.to.emit(solverVault, "Deposit")
				.withArgs(await depositorUser.getAddress(), depositAmount)
			await expect(depositTx)
				.to.emit(solverVault, "DepositFromSymmio")
				.withArgs(await user.getAddress(), await depositorUser.getAddress(), await vaultRelayer.getAddress(), depositAmount)

			expect(await collateralToken.balanceOf(await vaultRelayer.getAddress())).to.equal(0)
			expect(await symmio.balanceOf(await solver.getAddress())).to.equal(depositAmount)
			expect(await solverVault.currentDeposit()).to.equal(depositAmount)
		})

		it("should reject calls from anything other than Symmio", async function () {
			await expect(
				vaultRelayer
					.connect(other)
					.onTransfer(
						await collateralToken.getAddress(),
						await user.getAddress(),
						await depositorUser.getAddress(),
						depositAmount,
						await solverVault.getAddress(),
					),
			).to.be.revertedWithCustomError(vaultRelayer, "UnauthorizedCaller")
		})

		it("should reject transfers to anything other than the configured vault", async function () {
			await expect(
				symmio
					.connect(owner)
					.callExternalTransferRelayer(
						await vaultRelayer.getAddress(),
						await user.getAddress(),
						await depositorUser.getAddress(),
						depositAmount,
						await other.getAddress(),
					),
			).to.be.revertedWithCustomError(vaultRelayer, "InvalidTarget")
		})

		it("should reject transfers for a vault with a different collateral", async function () {
			await expect(
				symmio
					.connect(owner)
					.callExternalTransferRelayerWithCollateral(
						await vaultRelayer.getAddress(),
						await collateralToken2.getAddress(),
						await user.getAddress(),
						await depositorUser.getAddress(),
						depositAmount,
						await solverVault.getAddress(),
					),
			).to.be.revertedWithCustomError(vaultRelayer, "InvalidCollateral")
		})
	})

	describe("UUPS upgradeability", function () {
		async function deployUupsVault() {
			const SolverVaultFactory = await ethers.getContractFactory("SolverVault")

			return (await deployProxy(
				hre,
				SolverVaultFactory,
				[await symmio.getAddress(), await solver.getAddress(), await owner.getAddress(), await owner.getAddress()],
				{ kind: "erc1967" },
			)) as any
		}

		it("admin can upgrade the implementation and keep state", async function () {
			const uupsVault = await deployUupsVault()
			const proxyAddress = await uupsVault.getAddress()
			const oldImplementation = await erc1967(hre).getImplementationAddress(proxyAddress)
			const oldSolver = await uupsVault.solver()

			const SolverVaultFactory = await ethers.getContractFactory("SolverVault")
			const newImplementation = await SolverVaultFactory.deploy()
			await newImplementation.waitForDeployment()
			await uupsVault.connect(owner).upgradeTo(await newImplementation.getAddress())

			const newImplementationAddress = await erc1967(hre).getImplementationAddress(proxyAddress)
			expect(newImplementationAddress).to.not.equal(oldImplementation)
			expect(newImplementationAddress).to.equal(await newImplementation.getAddress())
			expect(await uupsVault.solver()).to.equal(oldSolver)
		})

		it("non-admin cannot upgrade the implementation", async function () {
			const uupsVault = await deployUupsVault()
			const SolverVaultFactory = await ethers.getContractFactory("SolverVault")
			const newImplementation = await SolverVaultFactory.deploy()
			await newImplementation.waitForDeployment()

			await expect((uupsVault as any).connect(other).upgradeTo(await newImplementation.getAddress())).to.revert(ethers)
		})
	})

	describe("requestWithdraw", function () {
		const depositAmount = decimal(500, collateralDecimals)
		const withdrawAmount = decimal(300, collateralDecimals)

		beforeEach(async function () {
			await mintFor(user, depositAmount)
			await solverVault.connect(user).deposit(depositAmount)
		})

		it("should request withdraw with on-chain deposited balance", async function () {
			const rec = await receiver.getAddress()
			const sender = await user.getAddress()

			await expect(solverVault.connect(user).requestWithdraw(withdrawAmount, withdrawAmount, rec))
				.to.emit(solverVault, "WithdrawRequestEvent")
				.withArgs(0, sender, rec, withdrawAmount)

			const request = await solverVault.withdrawRequests(0)
			expect(request[0]).to.equal(rec)
			expect(request[1]).to.equal(sender)
			expect(request[2]).to.equal(withdrawAmount)
			expect(request[3]).to.equal(withdrawAmount)
			expect(request[4]).to.equal(RequestStatus.Pending)

			expect(await solverVault.currentDeposit()).to.be.eq(depositAmount)
			expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(0)
		})

		it("should fail when is paused", async function () {
			await solverVault.connect(pauser).pause()
			const rec = await receiver.getAddress()

			await expect(solverVault.connect(user).requestWithdraw(withdrawAmount, withdrawAmount, rec)).to.revert(ethers)
		})

		it("should fail with zero address receiver", async function () {
			await expect(solverVault.connect(user).requestWithdraw(withdrawAmount, withdrawAmount, ZeroAddress)).to.be.revertedWithCustomError(
				solverVault,
				"ZeroAddress",
			)
		})

		it("should fail with zero amount", async function () {
			await expect(solverVault.connect(user).requestWithdraw(0n, 0n, await receiver.getAddress())).to.be.revertedWithCustomError(
				solverVault,
				"AmountMustBeGreaterThanZero",
			)
		})

		it("should fail to request more than the available deposited balance", async function () {
			const rec = await receiver.getAddress()
			const excessiveAmount = depositAmount + 1n

			await expect(solverVault.connect(user).requestWithdraw(excessiveAmount, excessiveAmount, rec)).to.be.revertedWithCustomError(
				solverVault,
				"InsufficientDepositedBalance",
			)
		})

		it("should update pendingWithdrawalAmount after request", async function () {
			const rec = await receiver.getAddress()

			expect(await solverVault.pendingWithdrawalAmount(await user.getAddress())).to.equal(0n)

			await solverVault.connect(user).requestWithdraw(withdrawAmount, withdrawAmount, rec)

			expect(await solverVault.pendingWithdrawalAmount(await user.getAddress())).to.equal(withdrawAmount)
		})

		it("should include pending withdrawals when checking available deposited balance", async function () {
			const rec = await receiver.getAddress()

			const firstAmount = decimal(300, collateralDecimals)
			const secondAmount = decimal(250, collateralDecimals)

			await solverVault.connect(user).requestWithdraw(firstAmount, firstAmount, rec)

			await expect(solverVault.connect(user).requestWithdraw(secondAmount, secondAmount, rec)).to.be.revertedWithCustomError(
				solverVault,
				"InsufficientDepositedBalance",
			)
		})

		describe("cancelWithdrawRequest", async function () {
			beforeEach(async function () {
				await solverVault.connect(user).requestWithdraw(withdrawAmount, withdrawAmount, await receiver.getAddress())
			})

			it("should cancel withdraw", async function () {
				await expect(solverVault.connect(user).cancelWithdrawRequest(0)).to.emit(solverVault, "WithdrawRequestCanceled").withArgs(0)
				const request = await solverVault.withdrawRequests(0)
				expect(request[4]).to.equal(RequestStatus.Canceled)
				expect(await solverVault.currentDeposit()).to.be.eq(depositAmount)
				expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(0)
			})

			it("should fail to cancel request by non-sender", async function () {
				await expect(solverVault.connect(other).cancelWithdrawRequest(0)).to.be.revertedWithCustomError(solverVault, "UnauthorizedRequestSender")
			})

			it("should fail to cancel invalid request ID", async function () {
				await expect(solverVault.connect(user).cancelWithdrawRequest(999)).to.be.revertedWithCustomError(solverVault, "InvalidRequestId")
			})

			it("should fail to cancel already canceled request", async function () {
				await solverVault.connect(user).cancelWithdrawRequest(0)
				await expect(solverVault.connect(user).cancelWithdrawRequest(0)).to.be.revertedWithCustomError(solverVault, "InvalidRequestStatus")
			})

			it("should decrease pendingWithdrawalAmount on cancel", async function () {
				expect(await solverVault.pendingWithdrawalAmount(await user.getAddress())).to.equal(withdrawAmount)

				await solverVault.connect(user).cancelWithdrawRequest(0)

				expect(await solverVault.pendingWithdrawalAmount(await user.getAddress())).to.equal(0)
			})
		})

		describe("acceptWithdrawRequest", function () {
			const requestIds = [0]
			const minAmountOut = (withdrawAmount * 6n) / 10n

			beforeEach(async function () {
				await solverVault.connect(user).requestWithdraw(withdrawAmount, minAmountOut, await receiver.getAddress())
			})

			it("should fail on invalid Id", async function () {
				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, [5], [10])).to.be.revertedWithCustomError(solverVault, "InvalidRequestId")
			})

			it("should fail with insufficient contract balance", async () => {
				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])).to.be.revertedWithCustomError(
					solverVault,
					"InsufficientContractBalance",
				)
			})

			it("should accept withdraw request", async function () {
				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount)
				const receiverBalanceBefore = await collateralToken.balanceOf(await receiver.getAddress())

				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount]))
					.to.emit(solverVault, "WithdrawRequestAcceptedEvent")
					.withArgs(0, requestIds, [withdrawAmount])

				const request = await solverVault.withdrawRequests(0)
				expect(request[4]).to.equal(RequestStatus.Done)
				expect((await collateralToken.balanceOf(await receiver.getAddress())) - receiverBalanceBefore).to.equal(withdrawAmount)
				expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(0n)
				expect(await (solverVault as any).depositedBalances(await user.getAddress())).to.equal(depositAmount - withdrawAmount)
			})

			it("should emit the payout event while accepting", async function () {
				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount)

				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount]))
					.to.emit(solverVault, "WithdrawClaimedEvent")
					.withArgs(0, await receiver.getAddress())
			})

			it("should not let accepted payouts be withdrawn by the balancer", async function () {
				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount)

				await solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])

				expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(0n)
				await expect(solverVault.connect(balancer).sweepCollateral(await receiver.getAddress(), 1n)).to.be.revertedWithCustomError(
					solverVault,
					"InsufficientBalance",
				)
			})

			it("should fail on invalid role", async function () {
				await expect(solverVault.connect(other).acceptWithdrawRequest(0, requestIds, [withdrawAmount])).to.revert(ethers)
			})

			it("should fail when paused", async function () {
				await solverVault.connect(pauser).pause()
				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])).to.revert(ethers)
			})

			it("should fail to accept already accepted request", async function () {
				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount)
				await solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])
				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])).to.be.revertedWithCustomError(
					solverVault,
					"InvalidAcceptedRequest",
				)
			})

			it("should accept withdraw request with provided amount", async function () {
				await mintFor(balancer, depositAmount)
				await collateralToken.connect(balancer).approve(await solverVault.getAddress(), depositAmount)
				const receiverBalanceBefore = await collateralToken.balanceOf(await receiver.getAddress())

				await expect(solverVault.connect(balancer).acceptWithdrawRequest(depositAmount, requestIds, [withdrawAmount]))
					.to.emit(solverVault, "WithdrawRequestAcceptedEvent")
					.withArgs(depositAmount, requestIds, [withdrawAmount])

				const request = await solverVault.withdrawRequests(0)
				expect(request[4]).to.equal(RequestStatus.Done)
				expect((await collateralToken.balanceOf(await receiver.getAddress())) - receiverBalanceBefore).to.equal(withdrawAmount)
				expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(depositAmount - withdrawAmount)
			})

			it("should reject mismatched acceptance arrays", async function () {
				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount)

				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [])).to.be.revertedWithCustomError(
					solverVault,
					"InvalidAcceptedRequest",
				)
			})

			it("should reject duplicate request ids", async function () {
				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount * 2n)

				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, [0, 0], [withdrawAmount, withdrawAmount])).to.be.revertedWithCustomError(
					solverVault,
					"InvalidAcceptedRequest",
				)
			})

			it("should fail to accept with insufficient balance", async function () {
				await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])).to.be.revertedWithCustomError(
					solverVault,
					"InsufficientContractBalance",
				)
			})

			it("should decrease pendingWithdrawalAmount on accept", async function () {
				expect(await solverVault.pendingWithdrawalAmount(await user.getAddress())).to.equal(withdrawAmount)

				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount)
				await solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])

				expect(await solverVault.pendingWithdrawalAmount(await user.getAddress())).to.equal(0)
			})

			it("should decrease deposited balance on accept", async function () {
				expect(await (solverVault as any).depositedBalances(await user.getAddress())).to.equal(depositAmount)

				await collateralToken.mint(await solverVault.getAddress(), withdrawAmount)
				await solverVault.connect(balancer).acceptWithdrawRequest(0, requestIds, [withdrawAmount])

				expect(await (solverVault as any).depositedBalances(await user.getAddress())).to.equal(depositAmount - withdrawAmount)
			})
		})
	})

	describe("sweepCollateral", function () {
		const depositAmount = decimal(500, collateralDecimals)

		beforeEach(async function () {
			await collateralToken.mint(await solverVault.getAddress(), depositAmount)
		})

		it("should sweep excess collateral", async function () {
			const withdrawAmount = depositAmount / 2n
			const receiverAddr = await receiver.getAddress()
			const balanceBefore = await collateralToken.balanceOf(receiverAddr)

			await solverVault.connect(balancer).sweepCollateral(receiverAddr, withdrawAmount)

			const balanceAfter = await collateralToken.balanceOf(receiverAddr)
			expect(balanceAfter - balanceBefore).to.equal(withdrawAmount)
		})

		it("should fail with zero address receiver", async function () {
			await expect(solverVault.connect(balancer).sweepCollateral(ZeroAddress, 100n)).to.be.revertedWithCustomError(solverVault, "ZeroAddress")
		})

		it("should fail with zero amount", async function () {
			await expect(solverVault.connect(balancer).sweepCollateral(await receiver.getAddress(), 0n)).to.be.revertedWithCustomError(
				solverVault,
				"AmountMustBeGreaterThanZero",
			)
		})

		it("should sweep collateral that remains after accepted payouts", async function () {
			await mintFor(user, depositAmount)
			await solverVault.connect(user).deposit(depositAmount)

			const withdrawAmount = decimal(100, collateralDecimals)
			const minAmountOut = withdrawAmount
			const extraBalance = decimal(25, collateralDecimals)

			await solverVault.connect(user).requestWithdraw(withdrawAmount, minAmountOut, await receiver.getAddress())

			await collateralToken.mint(await solverVault.getAddress(), withdrawAmount + extraBalance)

			await solverVault.connect(balancer).acceptWithdrawRequest(0, [0], [minAmountOut])

			const contractBalance = await collateralToken.balanceOf(await solverVault.getAddress())

			const remainingBalance = depositAmount + extraBalance
			expect(contractBalance).to.equal(remainingBalance)

			await solverVault.connect(balancer).sweepCollateral(await receiver.getAddress(), remainingBalance)

			expect(await collateralToken.balanceOf(await solverVault.getAddress())).to.equal(0n)

			await expect(solverVault.connect(balancer).sweepCollateral(await receiver.getAddress(), 1n)).to.be.revertedWithCustomError(
				solverVault,
				"InsufficientBalance",
			)
		})

		it("should fail with invalid role", async function () {
			await expect(solverVault.connect(other).sweepCollateral(await receiver.getAddress(), 100n)).to.revert(ethers)
		})

		it("should fail when paused", async function () {
			await solverVault.connect(pauser).pause()
			await expect(solverVault.connect(balancer).sweepCollateral(await receiver.getAddress(), 100n)).to.revert(ethers)
		})
	})

	describe("Multiple withdraw requests", function () {
		const depositAmount = decimal(1000, collateralDecimals)
		const withdrawAmount1 = decimal(300, collateralDecimals)
		const withdrawAmount2 = decimal(400, collateralDecimals)

		beforeEach(async function () {
			await mintFor(user, depositAmount)
			await solverVault.connect(user).deposit(depositAmount)
		})

		it("should handle multiple withdraw requests", async function () {
			const rec = await receiver.getAddress()

			await solverVault.connect(user).requestWithdraw(withdrawAmount1, 0n, rec)

			await solverVault.connect(user).requestWithdraw(withdrawAmount2, 0n, rec)

			expect(await solverVault.pendingWithdrawalAmount(await user.getAddress())).to.equal(withdrawAmount1 + withdrawAmount2)

			const request0 = await solverVault.withdrawRequests(0)
			const request1 = await solverVault.withdrawRequests(1)

			expect(request0.amount).to.equal(withdrawAmount1)
			expect(request1.amount).to.equal(withdrawAmount2)
		})

		it("should accept multiple requests at once", async function () {
			const rec = await receiver.getAddress()

			await solverVault.connect(user).requestWithdraw(withdrawAmount1, 0n, rec)

			await solverVault.connect(user).requestWithdraw(withdrawAmount2, 0n, rec)

			const paybackRatio = decimal(1)
			const totalPayout = withdrawAmount1 + withdrawAmount2

			await collateralToken.mint(await solverVault.getAddress(), totalPayout)

			await expect(solverVault.connect(balancer).acceptWithdrawRequest(0, [0, 1], [withdrawAmount1, withdrawAmount2]))
				.to.emit(solverVault, "WithdrawRequestAcceptedEvent")
				.withArgs(0, [0, 1], [withdrawAmount1, withdrawAmount2])

			const request0 = await solverVault.withdrawRequests(0)
			const request1 = await solverVault.withdrawRequests(1)

			expect(request0[4]).to.equal(RequestStatus.Done)
			expect(request1[4]).to.equal(RequestStatus.Done)

			expect(await collateralToken.balanceOf(rec)).to.equal(totalPayout)
		})
	})
})
