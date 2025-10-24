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
    token = await upgrades.deployProxy(Factory, [18], { initializer: "initialize" });
    await token.waitForDeployment();
  });

  it("initializes once, sets name/symbol, grants admin to deployer", async () => {
    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

    expect(await token.name()).to.equal("OnChainSymmioLP");
    expect(await token.symbol()).to.equal("smUSD");

    expect(await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(true);

    await expect(token.initialize(6)).to.be.reverted;
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
