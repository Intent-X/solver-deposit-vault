// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

interface ISolverVault {
	struct WithdrawRequest {
		address receiver;
		address sender;
		uint256 amount;
		uint256 minAmountOut;
		RequestStatus status;
	}

	enum RequestStatus {
		Pending,
		Done,
		Canceled,
		Rejected
	}

	event Deposit(address indexed depositor, uint256 amount);
	event WithdrawRequestEvent(uint256 indexed requestId, address indexed sender, address indexed receiver, uint256 amount);
	event WithdrawRequestCanceled(uint256 indexed requestId);
	event WithdrawRequestRejected(uint256 indexed requestId);
	event WithdrawRequestAcceptedEvent(uint256 providedAmount, uint256[] acceptedRequestIds, uint256[] _acceptedAmounts);
	event WithdrawClaimedEvent(uint256 indexed requestId, address indexed receiver);
	event SymmioAddressUpdatedEvent(address indexed newSymmioAddress);
	event DepositLimitUpdatedEvent(uint256 depositLimit);
	event SolverUpdatedEvent(address indexed solver);
	event DepositToSymmio(address indexed depositor, address indexed solver, uint256 amount);
	event DepositFromSymmio(address indexed symmioSender, address indexed depositor, address indexed relayer, uint256 amount);
}
