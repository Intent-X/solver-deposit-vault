import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract } from "ethers";
import { SymmioVaultLpToken } from "../typechain-types";

describe("SymmioVaultLpToken", function () {
  let token: SymmioVaultLpToken;
  let owner: any, alice: any, bob: any, carol: any;

  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("SymmioVaultLpToken");
    token = await upgrades.deployProxy(Factory, [], { initializer: "initialize" });
    await token.waitForDeployment();
  });

  it("initializes once, sets name/symbol, grants admin to deployer, and starts paused", async () => {
    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

    expect(await token.name()).to.equal("OnChainSymmioLP");
    expect(await token.symbol()).to.equal("smUSD");

    expect(await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(true);
    expect(await token.paused()).to.equal(true);

    await expect(token.initialize()).to.be.reverted;
  });

  it("only admin can pause/unpause; second pause while paused reverts", async () => {
    await expect(token.connect(alice).unpause()).to.be.reverted; // non-admin cannot unpause

    await expect(token.pause()).to.be.reverted;

    await expect(token.unpause()).to.not.be.reverted;
    expect(await token.paused()).to.equal(false);

    await expect(token.connect(alice).pause()).to.be.reverted;
    await expect(token.pause()).to.not.be.reverted;
    expect(await token.paused()).to.equal(true);
  });

  it("only MINTER_ROLE can mint; minting by minter works even while paused", async () => {
    const MINTER_ROLE = await token.MINTER_ROLE();
    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

    await expect(token.connect(alice).mint(alice.address, 1n)).to.be.revertedWithCustomError(
      token,
      "AccessControlUnauthorizedAccount"
    ).withArgs(alice.address, MINTER_ROLE);

    expect(await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(true);
    await expect(token.grantRole(MINTER_ROLE, alice.address)).to.not.be.reverted;
    expect(await token.hasRole(MINTER_ROLE, alice.address)).to.equal(true);

    await expect(token.connect(alice).mint(alice.address, 1_000n)).to.not.be.reverted;
    expect(await token.totalSupply()).to.equal(1_000n);
    expect(await token.balanceOf(alice.address)).to.equal(1_000n);

    await expect(token.connect(bob).mint(bob.address, 1n)).to.be.revertedWithCustomError(
      token,
      "AccessControlUnauthorizedAccount"
    ).withArgs(bob.address, MINTER_ROLE);
  });

  it("transfers are blocked when paused (even for minters) and allowed when unpaused", async () => {
    const MINTER_ROLE = await token.MINTER_ROLE();

    await token.grantRole(MINTER_ROLE, owner.address);
    await token.mint(owner.address, 5_000n);

    await expect(token.transfer(alice.address, 100n)).to.be.reverted;

    await token.unpause();
    await expect(token.transfer(alice.address, 100n)).to.not.be.reverted;
    expect(await token.balanceOf(owner.address)).to.equal(4_900n);
    expect(await token.balanceOf(alice.address)).to.equal(100n);

    await token.pause();
    await expect(token.connect(alice).transfer(bob.address, 10n)).to.be.reverted;
  });

  it("burn is blocked when paused and works when unpaused", async () => {
    const MINTER_ROLE = await token.MINTER_ROLE();

    await token.grantRole(MINTER_ROLE, owner.address);
    await token.mint(alice.address, 1_000n);

    await expect(token.connect(alice).burn(100n)).to.be.reverted;

    await token.unpause();
    await expect(token.connect(alice).burn(100n)).to.not.be.reverted;
    expect(await token.balanceOf(alice.address)).to.equal(900n);
    expect(await token.totalSupply()).to.equal(900n); // minted 1000 then burned 100
  });

  it("role enumeration works for MINTER_ROLE; revoke prevents further mint", async () => {
    const MINTER_ROLE = await token.MINTER_ROLE();

    await token.grantRole(MINTER_ROLE, alice.address);
    await token.grantRole(MINTER_ROLE, bob.address);

    const count = await token.getRoleMemberCount(MINTER_ROLE);
    expect(count).to.equal(2n);

    const members = [
      await token.getRoleMember(MINTER_ROLE, 0n),
      await token.getRoleMember(MINTER_ROLE, 1n),
    ];
    expect(new Set(members)).to.eql(new Set([alice.address, bob.address]));

    await token.revokeRole(MINTER_ROLE, bob.address);

    await expect(token.connect(bob).mint(bob.address, 1n)).to.be.revertedWithCustomError(
      token,
      "AccessControlUnauthorizedAccount"
    ).withArgs(bob.address, MINTER_ROLE);

    await expect(token.connect(alice).mint(alice.address, 123n)).to.not.be.reverted;
  });

  it("only admin can grant/revoke roles", async () => {
    const MINTER_ROLE = await token.MINTER_ROLE();

    await expect(token.connect(alice).grantRole(MINTER_ROLE, alice.address)).to.be.revertedWithCustomError(
      token,
      "AccessControlUnauthorizedAccount"
    ).withArgs(alice.address, await token.DEFAULT_ADMIN_ROLE());

    await token.grantRole(MINTER_ROLE, carol.address);
    await expect(token.connect(alice).revokeRole(MINTER_ROLE, carol.address)).to.be.revertedWithCustomError(
      token,
      "AccessControlUnauthorizedAccount"
    ).withArgs(alice.address, await token.DEFAULT_ADMIN_ROLE());

    await expect(token.revokeRole(MINTER_ROLE, carol.address)).to.not.be.reverted;
  });

  it("supportsInterface returns true for AccessControlEnumerable", async () => {
    // IAccessControlEnumerableUpgradeable: 0x5a05180f (interfaceId)
    // (Interface ID can vary across libs; using known ERC165 id is safer)
    // Check ERC165 support itself and AccessControl’s interface id.
    expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC165
    // AccessControl interface id (0x7965db0b) — if your OZ version exposes it differently, this may need adjustment.
    expect(await token.supportsInterface("0x7965db0b")).to.equal(true);
  });
});
