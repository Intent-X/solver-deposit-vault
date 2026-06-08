// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ISolverVault.sol";

/// @title SolverVault
/// @notice Minimal custody vault. Balances are computed offchain; this contract only
///         tracks accounting numbers and exposes a public interface to request withdrawals.
contract SolverVault is
    ISolverVault,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
    bytes32 public constant REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");

    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("WithdrawRequest(address user,uint256 amount,address receiver,uint256 nonce,uint256 deadline)");

    IERC20 public collateralToken;

    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public pendingToWithdraw;

    mapping(address => uint256) public depositedPerUser;
    mapping(address => bool) public isWhitelisted;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    WithdrawRequest[] public withdrawRequests;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address collateralToken_) external initializer {
        require(admin != address(0), "SolverVault: Zero address admin");
        require(collateralToken_ != address(0), "SolverVault: Zero address collateral");

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuardTransient_init();
        __EIP712_init("SolverVault", "1");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTER_ROLE, admin);

        // The Setter manages every role (including itself and the admin role).
        _setRoleAdmin(DEFAULT_ADMIN_ROLE, SETTER_ROLE);
        _setRoleAdmin(SETTER_ROLE, SETTER_ROLE);
        _setRoleAdmin(EXECUTOR_ROLE, SETTER_ROLE);
        _setRoleAdmin(REBALANCER_ROLE, SETTER_ROLE);
        _setRoleAdmin(SIGNER_ROLE, SETTER_ROLE);

        collateralToken = IERC20(collateralToken_);
    }

    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "SolverVault: Amount must be greater than 0");
        collateralToken.safeTransferFrom(_msgSender(), address(this), amount);
        totalDeposited += amount;
        depositedPerUser[_msgSender()] += amount;
        emit Deposit(_msgSender(), amount);
    }

    function requestWithdraw(uint256 amount, address receiver, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        require(amount > 0, "SolverVault: Amount must be greater than 0");
        require(receiver != address(0), "SolverVault: Zero address for receiver");
        require(block.timestamp <= deadline, "SolverVault: Signature expired");
        require(!usedNonces[_msgSender()][nonce], "SolverVault: Nonce already used");

        bytes32 structHash =
            keccak256(abi.encode(WITHDRAW_TYPEHASH, _msgSender(), amount, receiver, nonce, deadline));
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        require(hasRole(SIGNER_ROLE, recovered), "SolverVault: Invalid signature");

        usedNonces[_msgSender()][nonce] = true;
        withdrawRequests.push(
            WithdrawRequest({
                user: _msgSender(),
                receiver: receiver,
                amount: amount,
                status: RequestStatus.Pending
            })
        );
        pendingToWithdraw += amount;
        emit WithdrawRequested(withdrawRequests.length - 1, _msgSender(), receiver, amount, nonce);
    }

    function acceptWithdrawRequest(uint256 id) external onlyRole(EXECUTOR_ROLE) whenNotPaused nonReentrant {
        require(id < withdrawRequests.length, "SolverVault: Invalid request ID");
        WithdrawRequest storage request = withdrawRequests[id];
        require(request.status == RequestStatus.Pending, "SolverVault: Invalid status");
        require(
            collateralToken.balanceOf(address(this)) >= request.amount, "SolverVault: Insufficient contract balance"
        );

        request.status = RequestStatus.Accepted;
        pendingToWithdraw -= request.amount;
        totalWithdrawn += request.amount;
        collateralToken.safeTransfer(request.receiver, request.amount);
        emit WithdrawAccepted(id, request.receiver, request.amount);
    }

    function rejectWithdrawRequest(uint256 id) external onlyRole(EXECUTOR_ROLE) whenNotPaused {
        require(id < withdrawRequests.length, "SolverVault: Invalid request ID");
        WithdrawRequest storage request = withdrawRequests[id];
        require(request.status == RequestStatus.Pending, "SolverVault: Invalid status");

        request.status = RequestStatus.Rejected;
        pendingToWithdraw -= request.amount;
        emit WithdrawRejected(id);
    }

    function cancelWithdrawRequest(uint256 id) external whenNotPaused {
        require(id < withdrawRequests.length, "SolverVault: Invalid request ID");
        WithdrawRequest storage request = withdrawRequests[id];
        require(request.user == _msgSender(), "SolverVault: Only the sender of request can cancel it");
        require(request.status == RequestStatus.Pending, "SolverVault: Invalid status");

        request.status = RequestStatus.Canceled;
        pendingToWithdraw -= request.amount;
        emit WithdrawCanceled(id);
    }

    /// @notice Rebalancer moves funds out of the vault to whitelisted addresses.
    /// @dev Does NOT affect totalWithdrawn or pendingToWithdraw accounting.
    function rebalance(address[] calldata to, uint256[] calldata amounts)
        external
        onlyRole(REBALANCER_ROLE)
        nonReentrant
    {
        require(to.length == amounts.length, "SolverVault: Length mismatch");
        for (uint256 i = 0; i < to.length; i++) {
            require(isWhitelisted[to[i]], "SolverVault: Receiver not whitelisted");
            require(amounts[i] > 0, "SolverVault: Amount must be greater than 0");
            collateralToken.safeTransfer(to[i], amounts[i]);
            emit Rebalanced(to[i], amounts[i]);
        }
    }

    function setWhitelist(address account, bool status) external onlyRole(SETTER_ROLE) {
        require(account != address(0), "SolverVault: Zero address");
        isWhitelisted[account] = status;
        emit WhitelistUpdated(account, status);
    }

    function pause() external onlyRole(SETTER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(SETTER_ROLE) {
        _unpause();
    }

    function withdrawRequestsLength() external view returns (uint256) {
        return withdrawRequests.length;
    }

    function nonceUsed(address user, uint256 nonce) external view returns (bool) {
        return usedNonces[user][nonce];
    }
}
