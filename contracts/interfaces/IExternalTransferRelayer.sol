// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

interface IExternalTransferRelayer {
	function onTransfer(address collateral, address sender, address receiver, uint256 amount, address target) external;
}
