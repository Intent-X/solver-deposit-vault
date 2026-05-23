// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

interface ISolverVaultRelayerTarget {
	function collateralTokenAddress() external view returns (address);

	function depositFromSymmio(address symmioSender, address depositor, uint256 amount) external;
}
