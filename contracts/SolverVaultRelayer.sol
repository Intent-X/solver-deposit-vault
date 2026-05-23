// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IExternalTransferRelayer.sol";
import "./interfaces/ISolverVaultRelayerTarget.sol";

/// @title SolverVaultRelayer
/// @notice Receives Symmio external-transfer callbacks and forwards the collateral into one vault.
contract SolverVaultRelayer is IExternalTransferRelayer {
	using SafeERC20 for IERC20;

	// -----------------------------------------------------------------------
	// Immutable routing
	// -----------------------------------------------------------------------

	address public immutable symmio;
	address public immutable vault;

	// -----------------------------------------------------------------------
	// Errors
	// -----------------------------------------------------------------------

	error InvalidAddress();
	error InvalidCollateral();
	error InvalidTarget();
	error UnauthorizedCaller();

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	constructor(address symmio_, address vault_) {
		if (symmio_ == address(0) || vault_ == address(0)) {
			revert InvalidAddress();
		}

		symmio = symmio_;
		vault = vault_;
	}

	// -----------------------------------------------------------------------
	// Symmio callback
	// -----------------------------------------------------------------------

	/// @notice Handles a Symmio external transfer and deposits the received collateral into the vault.
	/// @dev Only the configured Symmio may call this, and only the configured vault may be targeted.
	function onTransfer(address collateral, address sender, address receiver, uint256 amount, address target) external {
		if (msg.sender != symmio) {
			revert UnauthorizedCaller();
		}

		if (target != vault) {
			revert InvalidTarget();
		}

		if (collateral == address(0) || sender == address(0) || receiver == address(0) || target == address(0)) {
			revert InvalidAddress();
		}

		if (ISolverVaultRelayerTarget(target).collateralTokenAddress() != collateral) {
			revert InvalidCollateral();
		}

		IERC20(collateral).forceApprove(target, amount);
		ISolverVaultRelayerTarget(target).depositFromSymmio(sender, receiver, amount);
	}
}
