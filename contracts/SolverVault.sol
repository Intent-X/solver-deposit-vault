// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts-upgradeable/access/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ISolverVault.sol";
import "./interfaces/ISymmio.sol";

/// @title SolverVault
/// @notice Custodies user deposits, forwards collateral into Symmio for the solver,
/// and tracks withdrawal requests until a balancer supplies claimable collateral.
contract SolverVault is ISolverVault, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
	using SafeERC20 for IERC20;

	// -----------------------------------------------------------------------
	// Roles and constants
	// -----------------------------------------------------------------------

	bytes32 public constant BALANCER_ROLE = keccak256("BALANCER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	bytes32 public constant SYMMIO_RELAYER_ROLE = keccak256("SYMMIO_RELAYER_ROLE");

	// -----------------------------------------------------------------------
	// Errors
	// -----------------------------------------------------------------------

	error AmountMustBeGreaterThanZero();
	error CollateralCannotBeChanged();
	error DepositLimitReached();
	error InsufficientBalance();
	error InsufficientContractBalance();
	error InsufficientDepositedBalance();
	error InvalidAcceptedRequest();
	error InvalidCollateralDecimals();
	error InvalidRequestId();
	error InvalidRequestStatus();
	error PaybackRatioTooLow();
	error UnauthorizedRequestSender();
	error ZeroAddress();

	// -----------------------------------------------------------------------
	// Vault state
	// -----------------------------------------------------------------------

	ISymmio public symmio;
	address public solver;
	address public collateralTokenAddress;
	uint256 public depositLimit;
	uint256 public currentDeposit;
	WithdrawRequest[] public withdrawRequests;
	mapping(address => uint256) public pendingWithdrawalAmount;
	mapping(address => uint256) public depositedBalances;

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/// @notice Initializes the UUPS vault and binds it to one Symmio collateral.
	/// @dev The deployer receives SETTER_ROLE only during initialization so the
	/// Symmio address, solver, and deposit limit can be set.
	function initialize(address _symmioAddress, address _solver, address _balancer, address _multisig) external initializer {
		__Pausable_init();
		__ReentrancyGuard_init();
		__AccessControl_init();
		__UUPSUpgradeable_init();

		if (_balancer == address(0) || _multisig == address(0)) {
			revert ZeroAddress();
		}

		_grantRole(DEFAULT_ADMIN_ROLE, _multisig);
		_grantRole(SETTER_ROLE, _multisig);
		_grantRole(PAUSER_ROLE, _multisig);
		_grantRole(UNPAUSER_ROLE, _multisig);

		_grantRole(BALANCER_ROLE, _balancer);

		_grantRole(SETTER_ROLE, _msgSender());

		setSymmioAddress(_symmioAddress);
		setSolver(_solver);

		setDepositLimit(10_000_000 * 10 ** 6);
		_revokeRole(SETTER_ROLE, _msgSender());
	}

	// -----------------------------------------------------------------------
	// Deposits
	// -----------------------------------------------------------------------

	/// @notice Deposits caller collateral into the vault and forwards it to Symmio for the solver.
	function deposit(uint256 amount) external whenNotPaused nonReentrant {
		_depositFrom(_msgSender(), _msgSender(), amount);
	}

	/// @notice Records a deposit routed from Symmio through an authorized external-transfer relayer.
	/// @dev The relayer is the ERC20 payer; `depositor` receives the vault accounting credit.
	function depositFromSymmio(
		address symmioSender,
		address depositor,
		uint256 amount
	) external onlyRole(SYMMIO_RELAYER_ROLE) whenNotPaused nonReentrant {
		if (symmioSender == address(0) || depositor == address(0)) {
			revert ZeroAddress();
		}

		_depositFrom(_msgSender(), depositor, amount);
		emit DepositFromSymmio(symmioSender, depositor, _msgSender(), amount);
	}

	/// @dev Pulls collateral from `payer`, credits `depositor`, then deposits to Symmio for `solver`.
	function _depositFrom(address payer, address depositor, uint256 amount) internal {
		if (amount == 0) {
			revert AmountMustBeGreaterThanZero();
		}
		if (currentDeposit + amount > depositLimit) {
			revert DepositLimitReached();
		}

		IERC20 collateralToken = IERC20(collateralTokenAddress);
		collateralToken.safeTransferFrom(payer, address(this), amount);
		currentDeposit += amount;
		depositedBalances[depositor] += amount;
		emit Deposit(depositor, amount);

		collateralToken.forceApprove(address(symmio), amount);
		symmio.depositFor(solver, amount);
		emit DepositToSymmio(depositor, solver, amount);
	}

	// -----------------------------------------------------------------------
	// Withdrawal requests
	// -----------------------------------------------------------------------

	/// @notice Opens a withdrawal request against the caller's deposited balance.
	/// @dev Requested amounts remain pending until a balancer accepts, rejects, or the user cancels.
	function requestWithdraw(uint256 amount, uint256 minAmountOut, address receiver) external whenNotPaused {
		if (receiver == address(0)) {
			revert ZeroAddress();
		}
		if (amount == 0) {
			revert AmountMustBeGreaterThanZero();
		}
		if (depositedBalances[_msgSender()] < pendingWithdrawalAmount[_msgSender()] + amount) {
			revert InsufficientDepositedBalance();
		}
		withdrawRequests.push(
			WithdrawRequest({ sender: _msgSender(), receiver: receiver, amount: amount, minAmountOut: minAmountOut, status: RequestStatus.Pending })
		);
		pendingWithdrawalAmount[_msgSender()] += amount;
		emit WithdrawRequestEvent(withdrawRequests.length - 1, _msgSender(), receiver, amount);
	}

	/// @notice Cancels a pending withdrawal request owned by the caller.
	function cancelWithdrawRequest(uint256 id) external whenNotPaused {
		if (id >= withdrawRequests.length) {
			revert InvalidRequestId();
		}
		WithdrawRequest storage request = withdrawRequests[id];
		if (request.sender != _msgSender()) {
			revert UnauthorizedRequestSender();
		}
		if (request.status != RequestStatus.Pending) {
			revert InvalidRequestStatus();
		}
		request.status = RequestStatus.Canceled;
		pendingWithdrawalAmount[_msgSender()] -= request.amount;
		emit WithdrawRequestCanceled(id);
	}

	/// @notice Lets a balancer reject a pending withdrawal request without locking collateral.
	function rejectWithdrawRequest(uint256 id) external onlyRole(BALANCER_ROLE) whenNotPaused {
		if (id >= withdrawRequests.length) {
			revert InvalidRequestId();
		}
		WithdrawRequest storage request = withdrawRequests[id];
		if (request.status != RequestStatus.Pending) {
			revert InvalidRequestStatus();
		}
		request.status = RequestStatus.Rejected;
		pendingWithdrawalAmount[request.sender] -= request.amount;
		emit WithdrawRequestRejected(id);
	}

	/// @notice Accepts pending withdrawal requests and immediately pays their receivers.
	/// @dev Optional `providedAmount` lets the balancer transfer fresh collateral into the vault.
	function acceptWithdrawRequest(
		uint256 providedAmount,
		uint256[] memory _acceptedRequestIds,
		uint256[] memory _acceptedAmounts
	) external onlyRole(BALANCER_ROLE) whenNotPaused nonReentrant {
		if (_acceptedRequestIds.length != _acceptedAmounts.length) {
			revert InvalidAcceptedRequest();
		}

		IERC20 collateralToken = IERC20(collateralTokenAddress);
		if (providedAmount > 0) {
			collateralToken.safeTransferFrom(_msgSender(), address(this), providedAmount);
		}

		uint256 totalPayout;

		for (uint256 i = 0; i < _acceptedRequestIds.length; i++) {
			uint256 id = _acceptedRequestIds[i];
			if (id >= withdrawRequests.length) {
				revert InvalidRequestId();
			}
			WithdrawRequest storage request = withdrawRequests[id];
			if (request.status != RequestStatus.Pending) {
				revert InvalidAcceptedRequest();
			}
			uint256 amountOut = _acceptedAmounts[i];
			if (amountOut < request.minAmountOut) {
				revert PaybackRatioTooLow();
			}
			totalPayout += amountOut;
		}

		if (collateralToken.balanceOf(address(this)) < totalPayout) {
			revert InsufficientContractBalance();
		}

		for (uint256 i = 0; i < _acceptedRequestIds.length; i++) {
			uint256 id = _acceptedRequestIds[i];
			WithdrawRequest storage request = withdrawRequests[id];
			if (request.status != RequestStatus.Pending) {
				revert InvalidAcceptedRequest();
			}
			uint256 amountOut = _acceptedAmounts[i];

			currentDeposit -= request.amount;
			depositedBalances[request.sender] -= request.amount;
			request.status = RequestStatus.Done;
			pendingWithdrawalAmount[request.sender] -= request.amount;

			collateralToken.safeTransfer(request.receiver, amountOut);
			emit WithdrawClaimedEvent(id, request.receiver);
		}

		emit WithdrawRequestAcceptedEvent(providedAmount, _acceptedRequestIds, _acceptedAmounts);
	}

	// -----------------------------------------------------------------------
	// Admin configuration
	// -----------------------------------------------------------------------

	/// @notice Updates the Symmio contract while preventing collateral-token changes.
	function setSymmioAddress(address _symmioAddress) public onlyRole(SETTER_ROLE) {
		if (_symmioAddress == address(0)) {
			revert ZeroAddress();
		}
		symmio = ISymmio(_symmioAddress);
		address beforeCollateral = collateralTokenAddress;
		_updateCollateral();
		if (beforeCollateral != collateralTokenAddress && beforeCollateral != address(0)) {
			revert CollateralCannotBeChanged();
		}
		emit SymmioAddressUpdatedEvent(_symmioAddress);
	}

	/// @notice Updates the Symmio PartyB/solver account that receives forwarded deposits.
	function setSolver(address _solver) public onlyRole(SETTER_ROLE) {
		if (_solver == address(0)) {
			revert ZeroAddress();
		}
		solver = _solver;
		emit SolverUpdatedEvent(_solver);
	}

	/// @notice Sets the total active deposit ceiling for the vault.
	function setDepositLimit(uint256 _depositLimit) public onlyRole(SETTER_ROLE) {
		depositLimit = _depositLimit;
		emit DepositLimitUpdatedEvent(_depositLimit);
	}

	/// @notice Sweeps excess collateral that is not needed for immediate withdrawal payouts.
	function sweepCollateral(address receiver, uint256 amount) external onlyRole(BALANCER_ROLE) whenNotPaused {
		if (receiver == address(0)) {
			revert ZeroAddress();
		}
		if (amount == 0) {
			revert AmountMustBeGreaterThanZero();
		}
		IERC20 collateralToken = IERC20(collateralTokenAddress);
		uint256 currentBalance = collateralToken.balanceOf(address(this));
		if (amount > currentBalance) {
			revert InsufficientBalance();
		}
		collateralToken.safeTransfer(receiver, amount);
	}

	/// @notice Pauses user-facing vault actions.
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/// @notice Resumes user-facing vault actions.
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	// -----------------------------------------------------------------------
	// Upgrade and internal helpers
	// -----------------------------------------------------------------------

	/// @dev UUPS authorization gate; DEFAULT_ADMIN_ROLE owns implementation upgrades.
	function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

	/// @dev Reads Symmio collateral metadata and rejects unsupported token decimals.
	function _updateCollateral() internal {
		collateralTokenAddress = symmio.getCollateral();
		if (IERC20Metadata(collateralTokenAddress).decimals() > 18) {
			revert InvalidCollateralDecimals();
		}
	}
}
