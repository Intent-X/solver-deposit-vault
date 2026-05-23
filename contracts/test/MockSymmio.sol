// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IExternalTransferRelayer.sol";

contract MockSymmio {
	// Use SafeERC20 for safer token transfers
	using SafeERC20 for IERC20;

	address public collateral;
	mapping(address => uint256) public balances;

	constructor(address _collateral) {
		collateral = _collateral;
	}

	function getCollateral() external view returns (address) {
		return collateral;
	}

	function depositFor(address partyB, uint256 amount) external {
		IERC20(collateral).transferFrom(msg.sender, address(this), amount);
		balances[partyB] += amount;
	}

	function balanceOf(address partyB) external view returns (uint256) {
		return balances[partyB];
	}

	function callExternalTransferRelayer(address relayer, address sender, address receiver, uint256 amount, address target) external {
		IExternalTransferRelayer(relayer).onTransfer(collateral, sender, receiver, amount, target);
	}

	function callExternalTransferRelayerWithCollateral(
		address relayer,
		address transferCollateral,
		address sender,
		address receiver,
		uint256 amount,
		address target
	) external {
		IExternalTransferRelayer(relayer).onTransfer(transferCollateral, sender, receiver, amount, target);
	}
}
