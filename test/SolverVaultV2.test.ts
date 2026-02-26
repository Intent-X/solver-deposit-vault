import { expect } from "chai";
import { Signer, ZeroAddress } from "ethers";
import hre, { ethers, upgrades } from "hardhat";
import { OnChainSymmioVaultV2 } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

function decimal(n: number, decimal: bigint = 18n): bigint {
  return BigInt(n) * 10n ** decimal;
}

enum RequestStatus {
  Pending,
  Ready,
  Done,
  Canceled,
}

describe("OnChainSymmioVaultV2", function () {
  let symmioDepositor: OnChainSymmioVaultV2,
    collateralToken: any,
    collateralToken2: any,
    symmio: any,
    symmioWithDifferentCollateral: any;
  let owner: Signer,
    user: Signer,
    depositorUser: Signer,
    balancer: Signer,
    receiver: Signer,
    setter: Signer,
    pauser: Signer,
    unpauser: Signer,
    solver: Signer,
    signerWallet: Signer,
    other: Signer;
  let collateralDecimals = 6n;
  let BALANCER_ROLE: string,
    PAUSER_ROLE: string,
    UNPAUSER_ROLE: string,
    SETTER_ROLE: string;
  const depositLimit = decimal(100000);

  const DOMAIN_NAME = "OnChainSymmioVaultV2";
  const DOMAIN_VERSION = "1";
  const TYPE_HASH =
    "WithdrawRequest(uint256 amount,uint256 minAmountOut,address receiver,uint256 nonce,uint256 deadline)";

  async function getSignature(
    signer: Signer,
    amount: bigint,
    minAmountOut: bigint,
    receiver: string,
    nonce: bigint,
    deadline: bigint
  ): Promise<string> {
    const domain = {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await symmioDepositor.getAddress(),
    };

    const types = {
      WithdrawRequest: [
        { name: "amount", type: "uint256" },
        { name: "minAmountOut", type: "uint256" },
        { name: "receiver", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const value = {
      amount,
      minAmountOut,
      receiver,
      nonce,
      deadline,
    };

    return await signer.signTypedData(domain, types, value);
  }

  async function mintFor(signer: Signer, amount: BigInt) {
    await collateralToken.connect(owner).mint(signer.getAddress(), amount);
    await collateralToken
      .connect(signer)
      .approve(await symmioDepositor.getAddress(), amount);
  }

  beforeEach(async function () {
    [
      owner,
      user,
      depositorUser,
      balancer,
      receiver,
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

    collateralToken = await MockERC20.connect(owner).deploy(collateralDecimals);
    await collateralToken.waitForDeployment();

    collateralToken2 = await MockERC20.connect(owner).deploy(
      collateralDecimals + 1n
    );
    await collateralToken2.waitForDeployment();

    symmio = await Symmio.deploy(await collateralToken.getAddress());
    await symmio.waitForDeployment();

    symmioWithDifferentCollateral = await Symmio.deploy(
      await collateralToken2.getAddress()
    );
    await symmioWithDifferentCollateral.waitForDeployment();

    symmioDepositor = (await upgrades.deployProxy(SymmioSolverDepositorV2, [
      await symmio.getAddress(),
      await solver.getAddress(),
      await signerWallet.getAddress(),
      500000000000000000n, // 0.5
      depositLimit,
      depositLimit,
    ])) as any;

    BALANCER_ROLE = await symmioDepositor.BALANCER_ROLE();
    SETTER_ROLE = await symmioDepositor.SETTER_ROLE();
    PAUSER_ROLE = await symmioDepositor.PAUSER_ROLE();
    UNPAUSER_ROLE = await symmioDepositor.UNPAUSER_ROLE();

    await symmioDepositor
      .connect(owner)
      .grantRole(BALANCER_ROLE, balancer.getAddress());
    await symmioDepositor
      .connect(owner)
      .grantRole(SETTER_ROLE, setter.getAddress());
    await symmioDepositor
      .connect(owner)
      .grantRole(PAUSER_ROLE, pauser.getAddress());
    await symmioDepositor
      .connect(owner)
      .grantRole(UNPAUSER_ROLE, unpauser.getAddress());
  });

  describe("initialize", function () {
    it("should revert if initialize second time", async () => {
      await expect(
        symmioDepositor.initialize(
          await symmio.getAddress(),
          await solver.getAddress(),
          await signerWallet.getAddress(),
          500000000000000000n, // 0.5
          depositLimit,
          depositLimit
        )
      ).to.be.reverted;
    });

    it("should set initial values correctly", async function () {
      expect(await symmioDepositor.symmio()).to.equal(
        await symmio.getAddress()
      );
      expect(await symmioDepositor.solver()).to.equal(
        await solver.getAddress()
      );
      expect(await symmioDepositor.signer()).to.equal(
        await signerWallet.getAddress()
      );
      expect(await symmioDepositor.minimumPaybackRatio()).to.equal(
        500000000000000000n
      );
    });

    it("Should fail to update collateral", async () => {
      await expect(
        symmioDepositor
          .connect(owner)
          .setSymmioAddress(await symmioWithDifferentCollateral.getAddress())
      ).to.be.revertedWith(
        "SymmioSolverDepositor: Collateral can not be changed"
      );
    });

    it("Should fail to set invalid solver", async () => {
      await expect(
        symmioDepositor.connect(owner).setSolver(ZeroAddress)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address");
      await expect(
        symmioDepositor.connect(other).setSolver(await solver.getAddress())
      ).to.be.reverted;
    });

    it("Should fail to set invalid signer", async () => {
      await expect(
        symmioDepositor.connect(owner).setSigner(ZeroAddress)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address");
      await expect(
        symmioDepositor
          .connect(other)
          .setSigner(await signerWallet.getAddress())
      ).to.be.reverted;
    });

    it("Should update signer", async () => {
      await expect(
        symmioDepositor.connect(owner).setSigner(await other.getAddress())
      )
        .to.emit(symmioDepositor, "SignerUpdatedEvent")
        .withArgs(await other.getAddress());
      expect(await symmioDepositor.signer()).to.equal(await other.getAddress());
    });

    it("Should fail to set symmioAddress", async () => {
      await expect(
        symmioDepositor.connect(owner).setSymmioAddress(ZeroAddress)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address");
      await expect(
        symmioDepositor
          .connect(other)
          .setSymmioAddress(await solver.getAddress())
      ).to.be.reverted;
    });

    it("Should fail to change collateral", async () => {
      await expect(
        symmioDepositor
          .connect(setter)
          .setSymmioAddress(await symmioWithDifferentCollateral.getAddress())
      ).to.be.revertedWith(
        "SymmioSolverDepositor: Collateral can not be changed"
      );
    });

    it("Should pause/unpause with given roles", async () => {
      await symmioDepositor.connect(pauser).pause();
      await symmioDepositor.connect(unpauser).unpause();
      await expect(symmioDepositor.connect(other).pause()).to.be.reverted;
      await expect(symmioDepositor.connect(other).unpause()).to.be.reverted;
    });

    it("Should update deposit limit", async () => {
      await symmioDepositor.connect(setter).setDepositLimit(1000, 1000);
      await expect(symmioDepositor.connect(other).setDepositLimit(1000, 1000))
        .to.be.reverted;
    });

    it("Should update withdrawalPeriod", async () => {
      expect(await symmioDepositor.withdrawalPeriod()).to.be.eq(604800);
      await expect(
        symmioDepositor.connect(setter).setWithdrawalPeriod(60)
      ).to.be.emit(symmioDepositor, "WithdrawalPeriodUpdate");
      await expect(symmioDepositor.connect(other).setWithdrawalPeriod(60)).to.be
        .reverted;
      expect(await symmioDepositor.withdrawalPeriod()).to.be.eq(60);
    });

    it("Should fail to set minimumPaybackRatio below MIN_PAYBACK_RATIO", async () => {
      await expect(
        symmioDepositor.connect(owner).setMinimumPaybackRatio(decimal(40, 16n))
      ).to.be.revertedWith(
        "SymmioSolverDepositor: Minimum buyback ratio is too low"
      );
    });

    it("Should fail to set minimumPaybackRatio above 100%", async () => {
      await expect(
        symmioDepositor.connect(owner).setMinimumPaybackRatio(decimal(101, 16n))
      ).to.be.revertedWith(
        "SymmioSolverDepositor: Minimum buyback ratio is too high"
      );
    });
  });

  describe("deposit", function () {
    const depositAmount = decimal(1, collateralDecimals);

    beforeEach(async function () {
      await mintFor(user, depositAmount);
    });

    it("should deposit tokens", async function () {
      let depositTx = await symmioDepositor
        .connect(user)
        .deposit(depositAmount);
      await expect(depositTx)
        .to.emit(symmioDepositor, "Deposit")
        .withArgs(await user.getAddress(), depositAmount);
      await expect(depositTx)
        .to.emit(symmioDepositor, "DepositToSymmio")
        .withArgs(await user.getAddress(), solver, depositAmount);
      expect(
        await collateralToken.balanceOf(await symmioDepositor.getAddress())
      ).to.equal(0);
      expect(await symmio.balanceOf(await solver.getAddress())).to.equal(
        depositAmount
      );
      expect(await symmioDepositor.currentDeposit()).to.equal(depositAmount);
    });

    it("should fail when is paused", async function () {
      await symmioDepositor.connect(pauser).pause();
      await expect(symmioDepositor.connect(user).deposit(depositAmount)).to.be
        .reverted;
    });

    it("should fail if transfer fails", async function () {
      await expect(symmioDepositor.connect(other).deposit(depositAmount)).to.be
        .reverted;
    });

    it("should fail to deposit more than limit", async function () {
      await expect(
        symmioDepositor.connect(user).deposit(depositLimit + 1n)
      ).to.be.revertedWith("SymmioSolverDepositor: Deposit limit reached");
    });

    it("should fail to deposit zero amount", async function () {
      await expect(
        symmioDepositor.connect(user).deposit(0n)
      ).to.be.revertedWith(
        "SymmioSolverDepositor: Amount must be greater than 0"
      );
    });

    it("should update the current deposit amount", async function () {
      const amount = depositLimit - depositAmount + 1n;

      await symmioDepositor.connect(user).deposit(depositAmount);
      await expect(
        symmioDepositor.connect(other).deposit(amount)
      ).to.be.revertedWith("SymmioSolverDepositor: Deposit limit reached");

      const deadline = BigInt((await time.latest()) + 3600);
      const nonce = 0n;
      const signature = await getSignature(
        signerWallet,
        depositAmount,
        0n,
        await owner.getAddress(),
        nonce,
        deadline
      );
      await symmioDepositor
        .connect(user)
        .requestWithdraw(
          depositAmount,
          0,
          await owner.getAddress(),
          nonce,
          deadline,
          signature
        );
      await collateralToken.mint(symmioDepositor, decimal(5, 17n));
      await symmioDepositor
        .connect(balancer)
        .acceptWithdrawRequest(0, [0], decimal(5, 17n));

      await mintFor(user, amount);
      await expect(symmioDepositor.connect(user).deposit(amount)).to.not.be
        .reverted;
    });
  });

  describe("requestWithdraw", function () {
    const depositAmount = decimal(500, collateralDecimals);
    const withdrawAmount = decimal(300, collateralDecimals);

    beforeEach(async function () {
      await mintFor(user, depositAmount);
      await symmioDepositor.connect(user).deposit(depositAmount);
    });

    it("should request withdraw with valid signature", async function () {
      const rec = await receiver.getAddress();
      const sender = await user.getAddress();
      const nonce = 1n;
      const deadline = BigInt((await time.latest()) + 3600);

      const signature = await getSignature(
        signerWallet,
        withdrawAmount,
        withdrawAmount,
        rec,
        nonce,
        deadline
      );

      await expect(
        symmioDepositor
          .connect(user)
          .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline, signature)
      )
        .to.emit(symmioDepositor, "WithdrawRequestEvent")
        .withArgs(0, sender, rec, withdrawAmount, nonce);

      const request = await symmioDepositor.withdrawRequests(0);
      expect(request[0]).to.equal(rec);
      expect(request[1]).to.equal(sender);
      expect(request[2]).to.equal(withdrawAmount);
      expect(request[3]).to.equal(withdrawAmount);
      expect(request[4]).to.equal(RequestStatus.Pending);
      expect(request[5]).to.equal(0n);

      expect(await symmioDepositor.currentDeposit()).to.be.eq(depositAmount);
      expect(
        await collateralToken.balanceOf(await symmioDepositor.getAddress())
      ).to.equal(0);
    });

    it("should fail when is paused", async function () {
      await symmioDepositor.connect(pauser).pause();
      const rec = await receiver.getAddress();
      const nonce = 1n;
      const deadline = BigInt((await time.latest()) + 3600);

      const signature = await getSignature(
        signerWallet,
        withdrawAmount,
        withdrawAmount,
        rec,
        nonce,
        deadline
      );

      await expect(
        symmioDepositor
          .connect(user)
          .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline, signature)
      ).to.be.reverted;
    });

    it("should fail with zero address receiver", async function () {
      const nonce = 1n;
      const deadline = BigInt((await time.latest()) + 3600);

      const signature = await getSignature(
        signerWallet,
        withdrawAmount,
        withdrawAmount,
        ZeroAddress,
        nonce,
        deadline
      );

      await expect(
        symmioDepositor
          .connect(user)
          .requestWithdraw(withdrawAmount, withdrawAmount, ZeroAddress, nonce, deadline, signature)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address for receiver");
    });

    describe("EIP712 Signature Verification", function () {
      it("should fail with invalid signature (wrong signer)", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) + 3600);

        const signature = await getSignature(
          other,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await expect(
          symmioDepositor
            .connect(user)
            .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline, signature)
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid signature");
      });

      it("should fail with expired deadline", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) - 1);

        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await expect(
          symmioDepositor
            .connect(user)
            .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline, signature)
        ).to.be.revertedWith(
          "SymmioSolverDepositor: Deadline must be in the future"
        );
      });

      it("should fail with reused nonce", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) + 3600);

        const signature1 = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await symmioDepositor
          .connect(user)
          .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline, signature1);

        const signature2 = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline + 3600n
        );

        await expect(
          symmioDepositor
            .connect(user)
            .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline + 3600n, signature2)
        ).to.be.revertedWith("SymmioSolverDepositor: Nonce already used");
      });

      it("should fail to use same signature by different users", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) + 3600);
        const smallAmount = decimal(10, collateralDecimals);

        await mintFor(other, depositAmount);
        await symmioDepositor.connect(other).deposit(depositAmount);

        const signature1 = await getSignature(
          signerWallet,
          smallAmount,
          smallAmount,
          rec,
          nonce,
          deadline
        );

        const signature2 = await getSignature(
          signerWallet,
          smallAmount,
          smallAmount,
          rec,
          nonce,
          deadline
        );

        await symmioDepositor
          .connect(user)
          .requestWithdraw(smallAmount, smallAmount, rec, nonce, deadline, signature1);

        await expect(
          symmioDepositor
            .connect(other)
            .requestWithdraw(smallAmount, smallAmount, rec, nonce, deadline, signature2)
        ).to.be.revertedWith("SymmioSolverDepositor: Nonce already used");
      });

      it("should fail with modified amount (signature mismatch)", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) + 3600);
        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await expect(
          symmioDepositor
            .connect(user)
            .requestWithdraw(withdrawAmount + 1n, withdrawAmount, rec, nonce, deadline, signature)
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid signature");
      });

      it("should fail with modified receiver (signature mismatch)", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) + 3600);

        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await expect(
          symmioDepositor
            .connect(user)
            .requestWithdraw(
              withdrawAmount,
              withdrawAmount,
              await other.getAddress(),
              nonce,
              deadline,
              signature
            )
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid signature");
      });

      it("should fail with modified minAmountOut (signature mismatch)", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) + 3600);

        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await expect(
          symmioDepositor
            .connect(user)
            .requestWithdraw(
              withdrawAmount,
              withdrawAmount - 1n,
              rec,
              nonce,
              deadline,
              signature
            )
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid signature");
      });

      it("should update usedNonces mapping after successful request", async function () {
        const rec = await receiver.getAddress();
        const nonce = 42n;
        const deadline = BigInt((await time.latest()) + 3600);

        expect(await symmioDepositor.usedNonces(await user.getAddress(), nonce)).to.be.false;

        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await symmioDepositor
          .connect(user)
          .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline, signature);

        expect(await symmioDepositor.usedNonces(rec, nonce)).to.be.true;
      });

      it("should update pendingWithdrawalAmount after request", async function () {
        const rec = await receiver.getAddress();
        const nonce = 1n;
        const deadline = BigInt((await time.latest()) + 3600);

        expect(await symmioDepositor.pendingWithdrawalAmount(await user.getAddress())).to.equal(0n);

        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          rec,
          nonce,
          deadline
        );

        await symmioDepositor
          .connect(user)
          .requestWithdraw(withdrawAmount, withdrawAmount, rec, nonce, deadline, signature);

        expect(await symmioDepositor.pendingWithdrawalAmount(await user.getAddress())).to.equal(
          withdrawAmount
        );
      });
    });

    describe("cancelWithdrawRequest", async function () {
      let nonce: bigint;
      let deadline: bigint;

      beforeEach(async function () {
        nonce = 1n;
        deadline = BigInt((await time.latest()) + 3600);

        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          withdrawAmount,
          await receiver.getAddress(),
          nonce,
          deadline
        );

        await symmioDepositor
          .connect(user)
          .requestWithdraw(
            withdrawAmount,
            withdrawAmount,
            await receiver.getAddress(),
            nonce,
            deadline,
            signature
          );
      });

      it("should cancel withdraw", async function () {
        await expect(symmioDepositor.connect(user).cancelWithdrawRequest(0))
          .to.emit(symmioDepositor, "WithdrawRequestCanceled")
          .withArgs(0);
        const request = await symmioDepositor.withdrawRequests(0);
        expect(request[4]).to.equal(RequestStatus.Canceled);
        expect(await symmioDepositor.currentDeposit()).to.be.eq(depositAmount);
        expect(
          await collateralToken.balanceOf(await symmioDepositor.getAddress())
        ).to.equal(0);
      });

      it("should fail to cancel request by non-sender", async function () {
        await expect(
          symmioDepositor.connect(other).cancelWithdrawRequest(0)
        ).to.be.revertedWith(
          "SymmioSolverDepositor: Only the sender of request can cancel it"
        );
      });

      it("should fail to cancel invalid request ID", async function () {
        await expect(
          symmioDepositor.connect(user).cancelWithdrawRequest(999)
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid request ID");
      });

      it("should fail to cancel already canceled request", async function () {
        await symmioDepositor.connect(user).cancelWithdrawRequest(0);
        await expect(
          symmioDepositor.connect(user).cancelWithdrawRequest(0)
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid status");
      });

      it("should decrease pendingWithdrawalAmount on cancel", async function () {
        expect(
          await symmioDepositor.pendingWithdrawalAmount(await user.getAddress())
        ).to.equal(withdrawAmount);

        await symmioDepositor.connect(user).cancelWithdrawRequest(0);

        expect(
          await symmioDepositor.pendingWithdrawalAmount(await user.getAddress())
        ).to.equal(0);
      });
    });

    describe("acceptWithdrawRequest", function () {
      const requestIds = [0];
      const paybackRatio = decimal(70, 16n);
      const minAmountOut = (withdrawAmount * 6n) / 10n;
      let nonce: bigint;
      let deadline: bigint;

      beforeEach(async function () {
        nonce = 1n;
        deadline = BigInt((await time.latest()) + 3600);

        const signature = await getSignature(
          signerWallet,
          withdrawAmount,
          minAmountOut,
          await receiver.getAddress(),
          nonce,
          deadline
        );

        await symmioDepositor
          .connect(user)
          .requestWithdraw(
            withdrawAmount,
            minAmountOut,
            await receiver.getAddress(),
            nonce,
            deadline,
            signature
          );
      });

      it("should fail on invalid Id", async function () {
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, [5], paybackRatio)
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid request ID");
      });

      it("should fail with insufficient contract balance", async () => {
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, paybackRatio)
        ).to.be.revertedWith(
          "SymmioSolverDepositor: Insufficient contract balance"
        );
      });

      it("should accept withdraw request", async function () {
        await collateralToken.mint(symmioDepositor, withdrawAmount);
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, paybackRatio)
        )
          .to.emit(symmioDepositor, "WithdrawRequestAcceptedEvent")
          .withArgs(0, requestIds, paybackRatio);
        const request = await symmioDepositor.withdrawRequests(0);
        expect(request[4]).to.equal(RequestStatus.Ready);
        expect(await symmioDepositor.lockedBalance()).to.equal(
          (request.amount * paybackRatio) / decimal(1)
        );
      });

      it("should fail on lower than minAmountOut", async function () {
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, decimal(55, 16n))
        ).to.be.revertedWith(
          "SymmioSolverDepositor: Payback ratio is too low for this request"
        );
      });

      it("should fail on invalid role", async function () {
        await expect(
          symmioDepositor
            .connect(other)
            .acceptWithdrawRequest(0, requestIds, paybackRatio)
        ).to.be.reverted;
      });

      it("should fail when paused", async function () {
        await symmioDepositor.connect(pauser).pause();
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, paybackRatio)
        ).to.be.reverted;
      });

      it("should fail to accept already accepted request", async function () {
        await collateralToken.mint(symmioDepositor, withdrawAmount);
        await symmioDepositor
          .connect(balancer)
          .acceptWithdrawRequest(0, requestIds, paybackRatio);
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, paybackRatio)
        ).to.be.revertedWith("SymmioSolverDepositor: Invalid accepted request");
      });

      it("should accept withdraw request with provided amount", async function () {
        await mintFor(balancer, depositAmount);
        await collateralToken
          .connect(balancer)
          .approve(symmioDepositor.getAddress(), depositAmount);
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(depositAmount, requestIds, paybackRatio)
        )
          .to.emit(symmioDepositor, "WithdrawRequestAcceptedEvent")
          .withArgs(depositAmount, requestIds, paybackRatio);
        const request = await symmioDepositor.withdrawRequests(0);
        expect(request[4]).to.equal(RequestStatus.Ready);
        expect(await symmioDepositor.lockedBalance()).to.equal(
          (request.amount * paybackRatio) / decimal(1)
        );
      });

      it("should fail to accept with insufficient balance", async function () {
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, paybackRatio)
        ).to.be.revertedWith(
          "SymmioSolverDepositor: Insufficient contract balance"
        );
      });

      it("should fail if payback ratio is too low", async function () {
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, decimal(40, 16n))
        ).to.be.revertedWith("SymmioSolverDepositor: Payback ratio is too low");
      });

      it("should fail if payback ratio is too high", async function () {
        await expect(
          symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, decimal(101, 16n))
        ).to.be.revertedWith("SymmioSolverDepositor: Payback ratio is too high");
      });

      it("should decrease pendingWithdrawalAmount on accept", async function () {
        expect(
          await symmioDepositor.pendingWithdrawalAmount(await user.getAddress())
        ).to.equal(withdrawAmount);

        await collateralToken.mint(symmioDepositor, withdrawAmount);
        await symmioDepositor
          .connect(balancer)
          .acceptWithdrawRequest(0, requestIds, paybackRatio);

        expect(
          await symmioDepositor.pendingWithdrawalAmount(await user.getAddress())
        ).to.equal(0);
      });

      describe("claimForWithdrawRequest", function () {
        const requestId = 0;
        let lockedBalance: bigint;

        beforeEach(async function () {
          await collateralToken.mint(symmioDepositor, withdrawAmount);
          await symmioDepositor
            .connect(balancer)
            .acceptWithdrawRequest(0, requestIds, paybackRatio);
          lockedBalance =
            ((await symmioDepositor.withdrawRequests(0)).amount *
              paybackRatio) /
            decimal(1);
        });

        it("should fail if not pass 7 days", async function () {
          await expect(
            symmioDepositor.connect(receiver).claimForWithdrawRequest(requestId)
          ).to.be.revertedWith(
            "SymmioSolverDepositor: Request not pass withdrawal period"
          );
        });

        it("should claim withdraw after 7 days cooldown", async function () {
          await time.increase(86400 * 7 + 1);
          await expect(
            symmioDepositor.connect(receiver).claimForWithdrawRequest(requestId)
          )
            .to.emit(symmioDepositor, "WithdrawClaimedEvent")
            .withArgs(requestId, await receiver.getAddress());
          const request = await symmioDepositor.withdrawRequests(0);
          expect(request[4]).to.equal(RequestStatus.Done);
        });

        it("should transfer correct amount to receiver", async function () {
          await time.increase(86400 * 7 + 1);
          const expectedAmount = (withdrawAmount * paybackRatio) / decimal(1);
          const balanceBefore = await collateralToken.balanceOf(
            await receiver.getAddress()
          );

          await symmioDepositor
            .connect(receiver)
            .claimForWithdrawRequest(requestId);

          const balanceAfter = await collateralToken.balanceOf(
            await receiver.getAddress()
          );
          expect(balanceAfter - balanceBefore).to.equal(expectedAmount);
        });

        it("should decrease locked balance after claim", async function () {
          await time.increase(86400 * 7 + 1);
          const expectedAmount = (withdrawAmount * paybackRatio) / decimal(1);

          const lockedBefore = await symmioDepositor.lockedBalance();
          await symmioDepositor
            .connect(receiver)
            .claimForWithdrawRequest(requestId);
          const lockedAfter = await symmioDepositor.lockedBalance();

          expect(lockedBefore - lockedAfter).to.equal(expectedAmount);
        });

        it("should fail when paused", async function () {
          await symmioDepositor.connect(pauser).pause();
          await expect(
            symmioDepositor.connect(receiver).claimForWithdrawRequest(requestId)
          ).to.be.reverted;
        });

        it("should fail on invalid ID", async function () {
          await expect(
            symmioDepositor.connect(receiver).claimForWithdrawRequest(1)
          ).to.be.revertedWith("SymmioSolverDepositor: Invalid request ID");
        });

        it("should fail if request is not ready", async function () {
          const nonce2 = 2n;
          const deadline2 = BigInt((await time.latest()) + 3600);

          const signature2 = await getSignature(
            signerWallet,
            withdrawAmount,
            withdrawAmount,
            await receiver.getAddress(),
            nonce2,
            deadline2
          );

          await symmioDepositor
            .connect(user)
            .requestWithdraw(
              withdrawAmount,
              withdrawAmount,
              await receiver.getAddress(),
              nonce2,
              deadline2,
              signature2
            );
          await expect(
            symmioDepositor.connect(receiver).claimForWithdrawRequest(1)
          ).to.be.revertedWith(
            "SymmioSolverDepositor: Request not ready for withdrawal"
          );
        });

        it("should fail if already claimed", async function () {
          await time.increase(86400 * 7 + 1);
          await symmioDepositor
            .connect(receiver)
            .claimForWithdrawRequest(requestId);
          await expect(
            symmioDepositor.connect(receiver).claimForWithdrawRequest(requestId)
          ).to.be.revertedWith(
            "SymmioSolverDepositor: Request not ready for withdrawal"
          );
        });
      });
    });
  });

  describe("withdrawNotLockedCollateralTokens", function () {
    const depositAmount = decimal(500, collateralDecimals);

    beforeEach(async function () {
      await collateralToken.mint(symmioDepositor, depositAmount);
    });

    it("should withdraw not locked tokens", async function () {
      const withdrawAmount = depositAmount / 2n;
      const receiverAddr = await receiver.getAddress();
      const balanceBefore = await collateralToken.balanceOf(receiverAddr);

      await symmioDepositor
        .connect(balancer)
        .withdrawNotLockedCollateralTokens(receiverAddr, withdrawAmount);

      const balanceAfter = await collateralToken.balanceOf(receiverAddr);
      expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
    });

    it("should fail with zero address receiver", async function () {
      await expect(
        symmioDepositor
          .connect(balancer)
          .withdrawNotLockedCollateralTokens(ZeroAddress, 100n)
      ).to.be.revertedWith("SymmioSolverDepositor: Zero address for receiver");
    });

    it("should fail with zero amount", async function () {
      await expect(
        symmioDepositor
          .connect(balancer)
          .withdrawNotLockedCollateralTokens(await receiver.getAddress(), 0n)
      ).to.be.revertedWith(
        "SymmioSolverDepositor: Amount must be greater than 0"
      );
    });

    it("should fail if trying to withdraw locked balance", async function () {
      await mintFor(user, depositAmount);
      await symmioDepositor.connect(user).deposit(depositAmount);

      const nonce = 1n;
      const deadline = BigInt((await time.latest()) + 3600);
      const withdrawAmount = decimal(100, collateralDecimals);
      const minAmountOut = withdrawAmount;

      const signature = await getSignature(
        signerWallet,
        withdrawAmount,
        minAmountOut,
        await receiver.getAddress(),
        nonce,
        deadline
      );

      await symmioDepositor
        .connect(user)
        .requestWithdraw(
          withdrawAmount,
          minAmountOut,
          await receiver.getAddress(),
          nonce,
          deadline,
          signature
        );

      await symmioDepositor
        .connect(balancer)
        .acceptWithdrawRequest(0, [0], decimal(1));

      const lockedBalance = await symmioDepositor.lockedBalance();
      const contractBalance = await collateralToken.balanceOf(
        await symmioDepositor.getAddress()
      );

      await expect(
        symmioDepositor
          .connect(balancer)
          .withdrawNotLockedCollateralTokens(
            await receiver.getAddress(),
            contractBalance - lockedBalance + 1n
          )
      ).to.be.revertedWith("SymmioSolverDepositor: Insufficient balance");
    });

    it("should fail with invalid role", async function () {
      await expect(
        symmioDepositor
          .connect(other)
          .withdrawNotLockedCollateralTokens(await receiver.getAddress(), 100n)
      ).to.be.reverted;
    });

    it("should fail when paused", async function () {
      await symmioDepositor.connect(pauser).pause();
      await expect(
        symmioDepositor
          .connect(balancer)
          .withdrawNotLockedCollateralTokens(await receiver.getAddress(), 100n)
      ).to.be.reverted;
    });
  });

  describe("Multiple withdraw requests", function () {
    const depositAmount = decimal(1000, collateralDecimals);
    const withdrawAmount1 = decimal(300, collateralDecimals);
    const withdrawAmount2 = decimal(400, collateralDecimals);

    beforeEach(async function () {
      await mintFor(user, depositAmount);
      await symmioDepositor.connect(user).deposit(depositAmount);
    });

    it("should handle multiple withdraw requests", async function () {
      const rec = await receiver.getAddress();
      const deadline = BigInt((await time.latest()) + 3600);

      const signature1 = await getSignature(
        signerWallet,
        withdrawAmount1,
        0n,
        rec,
        1n,
        deadline
      );

      const signature2 = await getSignature(
        signerWallet,
        withdrawAmount2,
        0n,
        rec,
        2n,
        deadline
      );

      await symmioDepositor
        .connect(user)
        .requestWithdraw(withdrawAmount1, 0n, rec, 1n, deadline, signature1);

      await symmioDepositor
        .connect(user)
        .requestWithdraw(withdrawAmount2, 0n, rec, 2n, deadline, signature2);

      expect(
        await symmioDepositor.pendingWithdrawalAmount(await user.getAddress())
      ).to.equal(withdrawAmount1 + withdrawAmount2);

      const request0 = await symmioDepositor.withdrawRequests(0);
      const request1 = await symmioDepositor.withdrawRequests(1);

      expect(request0.amount).to.equal(withdrawAmount1);
      expect(request1.amount).to.equal(withdrawAmount2);
    });

    it("should accept multiple requests at once", async function () {
      const rec = await receiver.getAddress();
      const deadline = BigInt((await time.latest()) + 3600);

      const signature1 = await getSignature(
        signerWallet,
        withdrawAmount1,
        0n,
        rec,
        1n,
        deadline
      );

      const signature2 = await getSignature(
        signerWallet,
        withdrawAmount2,
        0n,
        rec,
        2n,
        deadline
      );

      await symmioDepositor
        .connect(user)
        .requestWithdraw(withdrawAmount1, 0n, rec, 1n, deadline, signature1);

      await symmioDepositor
        .connect(user)
        .requestWithdraw(withdrawAmount2, 0n, rec, 2n, deadline, signature2);

      const paybackRatio = decimal(1);
      const totalPayout = withdrawAmount1 + withdrawAmount2;

      await collateralToken.mint(symmioDepositor, totalPayout);

      await expect(
        symmioDepositor
          .connect(balancer)
          .acceptWithdrawRequest(0, [0, 1], paybackRatio)
      )
        .to.emit(symmioDepositor, "WithdrawRequestAcceptedEvent")
        .withArgs(0, [0, 1], paybackRatio);

      const request0 = await symmioDepositor.withdrawRequests(0);
      const request1 = await symmioDepositor.withdrawRequests(1);

      expect(request0[4]).to.equal(RequestStatus.Ready);
      expect(request1[4]).to.equal(RequestStatus.Ready);

      expect(await symmioDepositor.lockedBalance()).to.equal(totalPayout);
    });
  });
});
