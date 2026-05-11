import { expect } from "chai";
import { getAddress, Signer, ZeroAddress } from "ethers";
import { ethers, upgrades } from "hardhat";
import { OnChainSymmioVaultV2 } from "../typechain-types";

function decimal(n: number, decimal: bigint = 18n): bigint {
  return BigInt(n) * 10n ** decimal;
}

describe("OnChainSymmioVaultV2 - depositViaInternalTransfer", function () {
  let symmioDepositor: OnChainSymmioVaultV2,
    collateralToken: any,
    symmio: any,
    multiAccount: any;
  let owner: Signer,
    subAccountOwner: Signer,
    balancer: Signer,
    setter: Signer,
    pauser: Signer,
    unpauser: Signer,
    solver: Signer,
    signerWallet: Signer,
    other: Signer;
  let collateralDecimals = 6n;
  let SETTER_ROLE: string;
  const depositLimit = decimal(100000);

  // a deterministic, non-zero address to use as the solver sub-account / sub-account handle
  const SOLVER_SUB_ACCOUNT = getAddress(
    "0x000000000000000000000000000000000000a11c"
  );
  const SUB_ACCOUNT = getAddress("0x000000000000000000000000000000000000b0b0");

  beforeEach(async function () {
    [
      owner,
      subAccountOwner,
      balancer,
      setter,
      pauser,
      unpauser,
      solver,
      signerWallet,
      other,
    ] = await ethers.getSigners();

    const SymmioSolverDepositorV2 = await ethers.getContractFactory(
      "OnChainSymmioVaultV2"
    );
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const Symmio = await ethers.getContractFactory("MockSymmio");
    const MultiAccount = await ethers.getContractFactory("MockMultiAccount");

    collateralToken = await MockERC20.connect(owner).deploy(collateralDecimals);
    await collateralToken.waitForDeployment();

    symmio = await Symmio.deploy(await collateralToken.getAddress());
    await symmio.waitForDeployment();

    multiAccount = await MultiAccount.deploy(await symmio.getAddress());
    await multiAccount.waitForDeployment();

    symmioDepositor = (await upgrades.deployProxy(SymmioSolverDepositorV2, [
      await symmio.getAddress(),
      await solver.getAddress(),
      await signerWallet.getAddress(),
      await owner.getAddress(),
      await owner.getAddress(),
    ])) as any;

    SETTER_ROLE = await symmioDepositor.SETTER_ROLE();
    const BALANCER_ROLE = await symmioDepositor.BALANCER_ROLE();
    const PAUSER_ROLE = await symmioDepositor.PAUSER_ROLE();
    const UNPAUSER_ROLE = await symmioDepositor.UNPAUSER_ROLE();

    await symmioDepositor
      .connect(owner)
      .grantRole(BALANCER_ROLE, balancer.getAddress());
    await symmioDepositor
      .connect(owner)
      .grantRole(SETTER_ROLE, owner.getAddress());
    await symmioDepositor
      .connect(owner)
      .grantRole(SETTER_ROLE, setter.getAddress());
    await symmioDepositor
      .connect(owner)
      .grantRole(PAUSER_ROLE, pauser.getAddress());
    await symmioDepositor
      .connect(owner)
      .grantRole(UNPAUSER_ROLE, unpauser.getAddress());

    // wire up the sub-account ownership in the mock multiaccount
    await multiAccount.setOwner(
      SUB_ACCOUNT,
      await subAccountOwner.getAddress()
    );
  });

  async function configure() {
    await symmioDepositor
      .connect(setter)
      .setMultiAccount(await multiAccount.getAddress());
    await symmioDepositor
      .connect(setter)
      .setSolverSubAccount(SOLVER_SUB_ACCOUNT);
  }

  describe("setMultiAccount", function () {
    it("should set multiAccount and emit event", async function () {
      await expect(
        symmioDepositor
          .connect(setter)
          .setMultiAccount(await multiAccount.getAddress())
      )
        .to.emit(symmioDepositor, "MultiAccountUpdatedEvent")
        .withArgs(await multiAccount.getAddress());
      expect(await symmioDepositor.multiAccount()).to.equal(
        await multiAccount.getAddress()
      );
    });

    it("should revert for non-SETTER caller", async function () {
      await expect(
        symmioDepositor
          .connect(other)
          .setMultiAccount(await multiAccount.getAddress())
      ).to.be.reverted;
    });

    it("should revert on zero address", async function () {
      await expect(
        symmioDepositor.connect(setter).setMultiAccount(ZeroAddress)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address");
    });
  });

  describe("setSolverSubAccount", function () {
    it("should set solverSubAccount and emit event", async function () {
      await expect(
        symmioDepositor.connect(setter).setSolverSubAccount(SOLVER_SUB_ACCOUNT)
      )
        .to.emit(symmioDepositor, "SolverSubAccountUpdatedEvent")
        .withArgs(SOLVER_SUB_ACCOUNT);
      expect(await symmioDepositor.solverSubAccount()).to.equal(
        SOLVER_SUB_ACCOUNT
      );
    });

    it("should revert for non-SETTER caller", async function () {
      await expect(
        symmioDepositor.connect(other).setSolverSubAccount(SOLVER_SUB_ACCOUNT)
      ).to.be.reverted;
    });

    it("should revert on zero address", async function () {
      await expect(
        symmioDepositor.connect(setter).setSolverSubAccount(ZeroAddress)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address");
    });
  });

  describe("depositViaInternalTransfer", function () {
    const amount = decimal(10, collateralDecimals);

    it("happy path: credits currentDeposit, leaves vault ERC20 untouched, emits events, bumps allocated balance", async function () {
      await configure();

      const vaultAddr = await symmioDepositor.getAddress();
      const vaultBalBefore = await collateralToken.balanceOf(vaultAddr);
      const allocatedBefore = await symmio.allocatedBalanceOfPartyA(
        SOLVER_SUB_ACCOUNT
      );

      const tx = await symmioDepositor
        .connect(subAccountOwner)
        .depositViaInternalTransfer(SUB_ACCOUNT, amount);

      await expect(tx)
        .to.emit(symmioDepositor, "Deposit")
        .withArgs(await subAccountOwner.getAddress(), amount);
      await expect(tx)
        .to.emit(symmioDepositor, "DepositViaInternalTransfer")
        .withArgs(await subAccountOwner.getAddress(), SUB_ACCOUNT, amount);

      expect(await symmioDepositor.currentDeposit()).to.equal(amount);
      expect(await collateralToken.balanceOf(vaultAddr)).to.equal(
        vaultBalBefore
      );
      expect(
        await symmio.allocatedBalanceOfPartyA(SOLVER_SUB_ACCOUNT)
      ).to.equal(allocatedBefore + amount);
    });

    it("should not emit DepositToSymmio (no ERC20 path)", async function () {
      await configure();
      const tx = await symmioDepositor
        .connect(subAccountOwner)
        .depositViaInternalTransfer(SUB_ACCOUNT, amount);
      await expect(tx).to.not.emit(symmioDepositor, "DepositToSymmio");
    });

    it("should revert when caller is not the subAccount owner", async function () {
      await configure();
      await expect(
        symmioDepositor
          .connect(other)
          .depositViaInternalTransfer(SUB_ACCOUNT, amount)
      ).to.be.revertedWith("SymmioSolverDepositor: Not subAccount owner");
    });

    it("should revert on zero amount", async function () {
      await configure();
      await expect(
        symmioDepositor
          .connect(subAccountOwner)
          .depositViaInternalTransfer(SUB_ACCOUNT, 0n)
      ).to.be.revertedWith(
        "SymmioSolverDepositor: Amount must be greater than 0"
      );
    });

    it("should revert when exceeding deposit limit", async function () {
      await configure();
      await expect(
        symmioDepositor
          .connect(subAccountOwner)
          .depositViaInternalTransfer(SUB_ACCOUNT, depositLimit + 1n)
      ).to.be.revertedWith("SymmioSolverDepositor: Deposit limit reached");
    });

    it("should revert when multiAccount is unset", async function () {
      // only set solverSubAccount, leave multiAccount unset
      await symmioDepositor
        .connect(setter)
        .setSolverSubAccount(SOLVER_SUB_ACCOUNT);
      await expect(
        symmioDepositor
          .connect(subAccountOwner)
          .depositViaInternalTransfer(SUB_ACCOUNT, amount)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address");
    });

    it("should revert when solverSubAccount is unset", async function () {
      // only set multiAccount, leave solverSubAccount unset
      await symmioDepositor
        .connect(setter)
        .setMultiAccount(await multiAccount.getAddress());
      await expect(
        symmioDepositor
          .connect(subAccountOwner)
          .depositViaInternalTransfer(SUB_ACCOUNT, amount)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address");
    });

    it("should revert with allocated balance mismatch when mock credits a different amount and leave currentDeposit unchanged", async function () {
      await configure();
      await multiAccount.setCreditMode(2); // credits double

      await expect(
        symmioDepositor
          .connect(subAccountOwner)
          .depositViaInternalTransfer(SUB_ACCOUNT, amount)
      ).to.be.revertedWith("SymmioSolverDepositor: Allocated balance mismatch");
      expect(await symmioDepositor.currentDeposit()).to.equal(0n);
    });

    it("should revert with allocated balance mismatch when mock credits nothing", async function () {
      await configure();
      await multiAccount.setCreditMode(1); // credits nothing

      await expect(
        symmioDepositor
          .connect(subAccountOwner)
          .depositViaInternalTransfer(SUB_ACCOUNT, amount)
      ).to.be.revertedWith("SymmioSolverDepositor: Allocated balance mismatch");
      expect(await symmioDepositor.currentDeposit()).to.equal(0n);
    });

    it("should revert when paused", async function () {
      await configure();
      await symmioDepositor.connect(pauser).pause();
      await expect(
        symmioDepositor
          .connect(subAccountOwner)
          .depositViaInternalTransfer(SUB_ACCOUNT, amount)
      ).to.be.reverted;
    });
  });
});
