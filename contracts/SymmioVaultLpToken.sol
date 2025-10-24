// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

contract SymmioVaultLpToken is
    ERC20BurnableUpgradeable,
    AccessControlEnumerableUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint8 internal _decimals;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(uint8 decimals_) external initializer {
        __ERC20_init("OnChainSymmioLP", "smUSD");
        __ERC20Burnable_init();
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _decimals = decimals_;
    }

    function decimals() public override view returns(uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
