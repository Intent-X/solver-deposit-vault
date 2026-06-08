import { expect } from "chai";
import { Signer, ZeroAddress } from "ethers";
import { ethers, upgrades } from "hardhat";
import { MockERC20, SolverVault } from "../typechain-types";

function decimal(n: number, decimals: bigint = 18n): bigint {
  return BigInt(n) * 10n ** decimals;
}

enum RequestStatus {
  Pending,
  Accepted,
  Rejected,
  Canceled,
}

describe("SolverVault", function () {
  let vault: SolverVault;
  let collateralToken: MockERC20;
  let owner: Signer,
    user: Signer,
    executor: Signer,
    rebalancer: Signer,
    signer: Signer,
    setter: Signer,
    receiver: Signer,
    whitelisted: Signer,
    other: Signer;

  let EXECUTOR_ROLE: string,
    SETTER_ROLE: string,
    REBALANCER_ROLE: string,
    SIGNER_ROLE: string;

  const collateralDecimals = 6n;

  async function mintFor(s: Signer, amount: bigint) {
    await collateralToken.connect(owner).mint(await s.getAddress(), amount);
    await collateralToken.connect(s).approve(await vault.getAddress(), amount);
  }

  async function signWithdraw(
    sig: Signer,
    user: string,
    amount: bigint,
    receiver: string,
    nonce: bigint,
    deadline: bigint
  ): Promise<string> {
    const domain = {
      name: "SolverVault",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await vault.getAddress(),
    };
    const types = {
      WithdrawRequest: [
        { name: "user", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "receiver", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    return sig.signTypedData(domain, types, {
      user,
      amount,
      receiver,
      nonce,
      deadline,
    });
  }

  async function futureDeadline(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp) + 3600n;
  }

  beforeEach(async function () {
    [
      owner,
      user,
      executor,
      rebalancer,
      signer,
      setter,
      receiver,
      whitelisted,
      other,
    ] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    collateralToken = (await MockERC20.connect(owner).deploy(
      collateralDecimals
    )) as any;
    await collateralToken.waitForDeployment();

    const SolverVault = await ethers.getContractFactory("SolverVault");
    vault = (await upgrades.deployProxy(
      SolverVault,
      [await owner.getAddress(), await collateralToken.getAddress()],
      { initializer: "initialize" }
    )) as any;

    EXECUTOR_ROLE = await vault.EXECUTOR_ROLE();
    SETTER_ROLE = await vault.SETTER_ROLE();
    REBALANCER_ROLE = await vault.REBALANCER_ROLE();
    SIGNER_ROLE = await vault.SIGNER_ROLE();

    await vault.connect(owner).grantRole(EXECUTOR_ROLE, executor.getAddress());
    await vault
      .connect(owner)
      .grantRole(REBALANCER_ROLE, rebalancer.getAddress());
    await vault.connect(owner).grantRole(SIGNER_ROLE, signer.getAddress());
    await vault.connect(owner).grantRole(SETTER_ROLE, setter.getAddress());
  });

  describe("initialize", function () {
    it("should set initial values correctly", async function () {
      expect(await vault.collateralToken()).to.equal(
        await collateralToken.getAddress()
      );
      expect(await vault.totalDeposited()).to.equal(0);
      expect(await vault.totalWithdrawn()).to.equal(0);
      expect(await vault.pendingToWithdraw()).to.equal(0);
      expect(
        await vault.hasRole(SETTER_ROLE, await owner.getAddress())
      ).to.equal(true);
    });

    it("should revert if initialized again", async function () {
      await expect(
        vault.initialize(
          await owner.getAddress(),
          await collateralToken.getAddress()
        )
      ).to.be.reverted;
    });

    it("should let the setter manage roles", async function () {
      await vault.connect(setter).grantRole(EXECUTOR_ROLE, other.getAddress());
      expect(
        await vault.hasRole(EXECUTOR_ROLE, await other.getAddress())
      ).to.equal(true);
    });
  });

  describe("deposit", function () {
    const depositAmount = decimal(100, collateralDecimals);

    beforeEach(async function () {
      await mintFor(user, depositAmount);
    });

    it("should deposit and track accounting", async function () {
      await expect(vault.connect(user).deposit(depositAmount))
        .to.emit(vault, "Deposit")
        .withArgs(await user.getAddress(), depositAmount);

      expect(await vault.totalDeposited()).to.equal(depositAmount);
      expect(await vault.depositedPerUser(await user.getAddress())).to.equal(
        depositAmount
      );
      expect(
        await collateralToken.balanceOf(await vault.getAddress())
      ).to.equal(depositAmount);
    });

    it("should fail to deposit zero", async function () {
      await expect(vault.connect(user).deposit(0)).to.be.revertedWith(
        "SolverVault: Amount must be greater than 0"
      );
    });

    it("should fail when paused", async function () {
      await vault.connect(setter).pause();
      await expect(vault.connect(user).deposit(depositAmount)).to.be.reverted;
    });
  });

  describe("requestWithdraw", function () {
    const amount = decimal(50, collateralDecimals);
    let nonce = 1n;

    it("should request withdraw with a valid signature", async function () {
      const deadline = await futureDeadline();
      const rec = await receiver.getAddress();
      const sig = await signWithdraw(
        signer,
        await user.getAddress(),
        amount,
        rec,
        nonce,
        deadline
      );

      await expect(
        vault.connect(user).requestWithdraw(amount, rec, nonce, deadline, sig)
      )
        .to.emit(vault, "WithdrawRequested")
        .withArgs(0, await user.getAddress(), rec, amount, nonce);

      const req = await vault.withdrawRequests(0);
      expect(req.user).to.equal(await user.getAddress());
      expect(req.receiver).to.equal(rec);
      expect(req.amount).to.equal(amount);
      expect(req.status).to.equal(RequestStatus.Pending);
      expect(await vault.pendingToWithdraw()).to.equal(amount);
      expect(await vault.nonceUsed(await user.getAddress(), nonce)).to.equal(
        true
      );
    });

    it("should fail with a signature from a non-signer", async function () {
      const deadline = await futureDeadline();
      const rec = await receiver.getAddress();
      const sig = await signWithdraw(
        other,
        await user.getAddress(),
        amount,
        rec,
        nonce,
        deadline
      );
      await expect(
        vault.connect(user).requestWithdraw(amount, rec, nonce, deadline, sig)
      ).to.be.revertedWith("SolverVault: Invalid signature");
    });

    it("should fail when the signature was issued for a different user", async function () {
      const deadline = await futureDeadline();
      const rec = await receiver.getAddress();
      const sig = await signWithdraw(
        signer,
        await other.getAddress(),
        amount,
        rec,
        nonce,
        deadline
      );
      await expect(
        vault.connect(user).requestWithdraw(amount, rec, nonce, deadline, sig)
      ).to.be.revertedWith("SolverVault: Invalid signature");
    });

    it("should fail with an expired deadline", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) - 1n;
      const rec = await receiver.getAddress();
      const sig = await signWithdraw(
        signer,
        await user.getAddress(),
        amount,
        rec,
        nonce,
        deadline
      );
      await expect(
        vault.connect(user).requestWithdraw(amount, rec, nonce, deadline, sig)
      ).to.be.revertedWith("SolverVault: Signature expired");
    });

    it("should fail to reuse a nonce", async function () {
      const deadline = await futureDeadline();
      const rec = await receiver.getAddress();
      const sig = await signWithdraw(
        signer,
        await user.getAddress(),
        amount,
        rec,
        nonce,
        deadline
      );
      await vault
        .connect(user)
        .requestWithdraw(amount, rec, nonce, deadline, sig);
      await expect(
        vault.connect(user).requestWithdraw(amount, rec, nonce, deadline, sig)
      ).to.be.revertedWith("SolverVault: Nonce already used");
    });

    it("should fail with a zero receiver", async function () {
      const deadline = await futureDeadline();
      const sig = await signWithdraw(
        signer,
        await user.getAddress(),
        amount,
        ZeroAddress,
        nonce,
        deadline
      );
      await expect(
        vault
          .connect(user)
          .requestWithdraw(amount, ZeroAddress, nonce, deadline, sig)
      ).to.be.revertedWith("SolverVault: Zero address for receiver");
    });
  });

  describe("acceptWithdrawRequest / rejectWithdrawRequest / cancel", function () {
    const amount = decimal(50, collateralDecimals);
    const nonce = 7n;

    beforeEach(async function () {
      const deadline = await futureDeadline();
      const rec = await receiver.getAddress();
      const sig = await signWithdraw(
        signer,
        await user.getAddress(),
        amount,
        rec,
        nonce,
        deadline
      );
      await vault
        .connect(user)
        .requestWithdraw(amount, rec, nonce, deadline, sig);
    });

    it("should accept and pay the receiver when funds are available", async function () {
      await collateralToken
        .connect(owner)
        .mint(await vault.getAddress(), amount);

      await expect(vault.connect(executor).acceptWithdrawRequest(0))
        .to.emit(vault, "WithdrawAccepted")
        .withArgs(0, await receiver.getAddress(), amount);

      const req = await vault.withdrawRequests(0);
      expect(req.status).to.equal(RequestStatus.Accepted);
      expect(await vault.totalWithdrawn()).to.equal(amount);
      expect(await vault.pendingToWithdraw()).to.equal(0);
      expect(
        await collateralToken.balanceOf(await receiver.getAddress())
      ).to.equal(amount);
    });

    it("should fail to accept with insufficient vault balance", async function () {
      await expect(
        vault.connect(executor).acceptWithdrawRequest(0)
      ).to.be.revertedWith("SolverVault: Insufficient contract balance");
    });

    it("should fail to accept by non-executor", async function () {
      await collateralToken
        .connect(owner)
        .mint(await vault.getAddress(), amount);
      await expect(vault.connect(other).acceptWithdrawRequest(0)).to.be
        .reverted;
    });

    it("should fail to accept an invalid id", async function () {
      await expect(
        vault.connect(executor).acceptWithdrawRequest(5)
      ).to.be.revertedWith("SolverVault: Invalid request ID");
    });

    it("should reject a request", async function () {
      await expect(vault.connect(executor).rejectWithdrawRequest(0))
        .to.emit(vault, "WithdrawRejected")
        .withArgs(0);
      const req = await vault.withdrawRequests(0);
      expect(req.status).to.equal(RequestStatus.Rejected);
      expect(await vault.pendingToWithdraw()).to.equal(0);
    });

    it("should not accept an already rejected request", async function () {
      await vault.connect(executor).rejectWithdrawRequest(0);
      await collateralToken
        .connect(owner)
        .mint(await vault.getAddress(), amount);
      await expect(
        vault.connect(executor).acceptWithdrawRequest(0)
      ).to.be.revertedWith("SolverVault: Invalid status");
    });

    it("should let the user cancel a pending request", async function () {
      await expect(vault.connect(user).cancelWithdrawRequest(0))
        .to.emit(vault, "WithdrawCanceled")
        .withArgs(0);
      const req = await vault.withdrawRequests(0);
      expect(req.status).to.equal(RequestStatus.Canceled);
      expect(await vault.pendingToWithdraw()).to.equal(0);
    });

    it("should not let a non-owner cancel a request", async function () {
      await expect(
        vault.connect(other).cancelWithdrawRequest(0)
      ).to.be.revertedWith(
        "SolverVault: Only the sender of request can cancel it"
      );
    });
  });

  describe("rebalance", function () {
    const vaultBalance = decimal(1000, collateralDecimals);
    const amount = decimal(100, collateralDecimals);

    beforeEach(async function () {
      await collateralToken
        .connect(owner)
        .mint(await vault.getAddress(), vaultBalance);
      await vault
        .connect(setter)
        .setWhitelist(await whitelisted.getAddress(), true);
    });

    it("should withdraw to whitelisted addresses without touching totalWithdrawn", async function () {
      await expect(
        vault
          .connect(rebalancer)
          .rebalance([await whitelisted.getAddress()], [amount])
      )
        .to.emit(vault, "Rebalanced")
        .withArgs(await whitelisted.getAddress(), amount);

      expect(
        await collateralToken.balanceOf(await whitelisted.getAddress())
      ).to.equal(amount);
      expect(await vault.totalWithdrawn()).to.equal(0);
      expect(await vault.pendingToWithdraw()).to.equal(0);
    });

    it("should fail to withdraw to a non-whitelisted address", async function () {
      await expect(
        vault
          .connect(rebalancer)
          .rebalance([await other.getAddress()], [amount])
      ).to.be.revertedWith("SolverVault: Receiver not whitelisted");
    });

    it("should fail on length mismatch", async function () {
      await expect(
        vault
          .connect(rebalancer)
          .rebalance([await whitelisted.getAddress()], [amount, amount])
      ).to.be.revertedWith("SolverVault: Length mismatch");
    });

    it("should fail when called by non-rebalancer", async function () {
      await expect(
        vault
          .connect(other)
          .rebalance([await whitelisted.getAddress()], [amount])
      ).to.be.reverted;
    });
  });

  describe("setWhitelist", function () {
    it("should set and unset whitelist by setter", async function () {
      await expect(
        vault.connect(setter).setWhitelist(await whitelisted.getAddress(), true)
      )
        .to.emit(vault, "WhitelistUpdated")
        .withArgs(await whitelisted.getAddress(), true);
      expect(
        await vault.isWhitelisted(await whitelisted.getAddress())
      ).to.equal(true);

      await vault
        .connect(setter)
        .setWhitelist(await whitelisted.getAddress(), false);
      expect(
        await vault.isWhitelisted(await whitelisted.getAddress())
      ).to.equal(false);
    });

    it("should fail when called by non-setter", async function () {
      await expect(
        vault.connect(other).setWhitelist(await whitelisted.getAddress(), true)
      ).to.be.reverted;
    });
  });

  describe("pause / unpause", function () {
    it("should pause and unpause by setter", async function () {
      await vault.connect(setter).pause();
      expect(await vault.paused()).to.equal(true);
      await vault.connect(setter).unpause();
      expect(await vault.paused()).to.equal(false);
    });

    it("should fail to pause by non-setter", async function () {
      await expect(vault.connect(other).pause()).to.be.reverted;
    });
  });
});
