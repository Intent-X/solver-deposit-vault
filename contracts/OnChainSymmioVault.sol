// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity =0.8.28;

import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./SymmioVaultLpToken.sol";
import "./interfaces/ISymmio.sol";
import "./interfaces/IOnChainSymmioVault.sol";

contract OnChainSymmioVault is
    IOnChainSymmioVault,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable
{
    // Use SafeERC20 for safer token transfers
    using SafeERC20 for IERC20;

    bytes32 public constant BALANCER_ROLE = keccak256("BALANCER_ROLE");
    bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
    uint256 public constant MIN_PAYBACK_RATIO = 0.5e18; // 50%

    ISymmio public symmio;
    address public solver;
    address public collateralTokenAddress;
    address public lpTokenAddress;
    uint256 public lockedBalance;
    uint256 public minimumPaybackRatio;
    uint256 public depositLimit;
    uint256 public depositPerUserLimit;
    uint256 public currentDeposit;
    uint256 public collateralTokenDecimals;
    WithdrawRequest[] public withdrawRequests;
    uint256 public withdrawalPeriod;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _symmioAddress,
        address _lpTokenAddress,
        address _solver,
        uint256 _minimumPaybackRatio,
        uint256 _depositLimit,
        uint256 _depositPerUserLimit
    ) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _grantRole(SETTER_ROLE, _msgSender());

        setSymmioAddress(_symmioAddress);
        _setLpTokenAddress(_lpTokenAddress);
        setDepositLimit(_depositLimit, _depositPerUserLimit);
        setSolver(_solver);
        setMinimumPaybackRatio(_minimumPaybackRatio);
        _setWithdrawalPeriod(604800);
    }

    function deposit(uint256 amount) external whenNotPaused {
        require(
            currentDeposit + amount <= depositLimit,
            "SymmioSolverDepositor: Deposit limit reached"
        );
        SymmioVaultLpToken lpToken = SymmioVaultLpToken(lpTokenAddress);
        require(
            lpToken.balanceOf(_msgSender()) + amount <= depositPerUserLimit,
            "SymmioSolverDepositor: Deposit per user limit reached"
        );

        IERC20 collateralToken = IERC20(collateralTokenAddress);
        collateralToken.safeTransferFrom(_msgSender(), address(this), amount);
        lpToken.mint(_msgSender(), amount);
        currentDeposit += amount;
        emit Deposit(_msgSender(), amount);

        require(
            collateralToken.approve(address(symmio), amount),
            "SymmioSolverDepositor: Approve failed"
        );
        symmio.depositFor(solver, amount);
        emit DepositToSymmio(_msgSender(), solver, amount);
    }

    function requestWithdraw(
        uint256 amount,
        uint256 minAmountOut,
        address receiver
    ) external whenNotPaused {
        require(
            SymmioVaultLpToken(lpTokenAddress).balanceOf(_msgSender()) >=
                amount,
            "SymmioSolverDepositor: Insufficient token balance"
        );
        SymmioVaultLpToken(lpTokenAddress).burnFrom(_msgSender(), amount);
        require(
            receiver != address(0),
            "SymmioSolverDepositor: Zero address for receiver"
        );
        withdrawRequests.push(
            WithdrawRequest({
                sender: _msgSender(),
                receiver: receiver,
                amount: amount,
                minAmountOut: minAmountOut,
                status: RequestStatus.Pending,
                acceptedRatio: 0,
                acceptedWithdawRequestTimestamp: 0
            })
        );
        emit WithdrawRequestEvent(
            withdrawRequests.length - 1,
            _msgSender(),
            receiver,
            amount
        );
    }

    function cancelWithdrawRequest(uint256 id) external whenNotPaused {
        require(
            id < withdrawRequests.length,
            "SymmioSolverDepositor: Invalid request ID"
        );
        WithdrawRequest storage request = withdrawRequests[id];
        require(
            request.sender == _msgSender(),
            "SymmioSolverDepositor: Only the sender of request can cancel it"
        );
        require(
            request.status == RequestStatus.Pending,
            "SymmioSolverDepositor: Invalid status"
        );
        request.status = RequestStatus.Canceled;
        SymmioVaultLpToken(lpTokenAddress).mint(_msgSender(), request.amount);
        emit WithdrawRequestCanceled(id);
    }

    function acceptWithdrawRequest(
        uint256 providedAmount,
        uint256[] memory _acceptedRequestIds,
        uint256 _paybackRatio
    ) external onlyRole(BALANCER_ROLE) whenNotPaused {
        IERC20(collateralTokenAddress).safeTransferFrom(
            _msgSender(),
            address(this),
            providedAmount
        );
        require(
            _paybackRatio >= minimumPaybackRatio,
            "SymmioSolverDepositor: Payback ratio is too low"
        );
        require(
            _paybackRatio <= 1e18,
            "SymmioSolverDepositor: Payback ratio is too high"
        );
        uint256 totalRequiredBalance = lockedBalance;

        for (uint256 i = 0; i < _acceptedRequestIds.length; i++) {
            uint256 id = _acceptedRequestIds[i];
            require(
                id < withdrawRequests.length,
                "SymmioSolverDepositor: Invalid request ID"
            );
            require(
                withdrawRequests[id].status == RequestStatus.Pending,
                "SymmioSolverDepositor: Invalid accepted request"
            );
            uint256 amountOut = (withdrawRequests[id].amount * _paybackRatio) /
                1e18;
            require(
                amountOut >= withdrawRequests[id].minAmountOut,
                "SymmioSolverDepositor: Payback ratio is too low for this request"
            );
            totalRequiredBalance += amountOut;
            currentDeposit -= withdrawRequests[id].amount;
            withdrawRequests[id].status = RequestStatus.Ready;
            withdrawRequests[id].acceptedRatio = _paybackRatio;
            withdrawRequests[id].acceptedWithdawRequestTimestamp = block
                .timestamp;
        }

        require(
            IERC20(collateralTokenAddress).balanceOf(address(this)) >=
                totalRequiredBalance,
            "SymmioSolverDepositor: Insufficient contract balance"
        );
        lockedBalance = totalRequiredBalance;
        emit WithdrawRequestAcceptedEvent(
            providedAmount,
            _acceptedRequestIds,
            _paybackRatio
        );
    }

    function claimForWithdrawRequest(uint256 requestId) external whenNotPaused {
        require(
            requestId < withdrawRequests.length,
            "SymmioSolverDepositor: Invalid request ID"
        );
        WithdrawRequest storage request = withdrawRequests[requestId];

        require(
            request.status == RequestStatus.Ready,
            "SymmioSolverDepositor: Request not ready for withdrawal"
        );

        require(
            request.acceptedWithdawRequestTimestamp + withdrawalPeriod <=
                block.timestamp,
            "SymmioSolverDepositor: Request not pass withdrawal period"
        );

        request.status = RequestStatus.Done;
        uint256 amount = (request.amount * request.acceptedRatio) / 1e18;
        lockedBalance -= amount;
        IERC20(collateralTokenAddress).safeTransfer(request.receiver, amount);
        emit WithdrawClaimedEvent(requestId, request.receiver);
    }

    function setSymmioAddress(
        address _symmioAddress
    ) public onlyRole(SETTER_ROLE) {
        require(
            _symmioAddress != address(0),
            "SymmioSolverDepositor: Zero address"
        );
        symmio = ISymmio(_symmioAddress);
        address beforeCollateral = collateralTokenAddress;
        _updateCollateral();
        require(
            beforeCollateral == collateralTokenAddress ||
                beforeCollateral == address(0),
            "SymmioSolverDepositor: Collateral can not be changed"
        );
        emit SymmioAddressUpdatedEvent(_symmioAddress);
    }

    function setWithdrawalPeriod(
        uint256 withdrawalPeriod_
    ) public onlyRole(SETTER_ROLE) {
        _setWithdrawalPeriod(withdrawalPeriod_);
    }

    function setSolver(address _solver) public onlyRole(SETTER_ROLE) {
        require(_solver != address(0), "SymmioSolverDepositor: Zero address");
        solver = _solver;
        emit SolverUpdatedEvent(_solver);
    }

    function setDepositLimit(
        uint256 _depositLimit,
        uint256 _depositPerUserLimit
    ) public onlyRole(SETTER_ROLE) {
        depositLimit = _depositLimit;
        depositPerUserLimit = _depositPerUserLimit;
        emit DepositLimitUpdatedEvent(_depositLimit, _depositPerUserLimit);
    }

    function setMinimumPaybackRatio(
        uint256 _minimumPaybackRatio
    ) public onlyRole(SETTER_ROLE) {
        require(
            _minimumPaybackRatio >= MIN_PAYBACK_RATIO,
            "SymmioSolverDepositor: Minimum buyback ratio is too low"
        );
        require(
            _minimumPaybackRatio <= 1e18,
            "SymmioSolverDepositor: Minimum buyback ratio is too high"
        );
        minimumPaybackRatio = _minimumPaybackRatio;
        emit MinimumPaybackRatioUpdatedEvent(_minimumPaybackRatio);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(UNPAUSER_ROLE) {
        _unpause();
    }

    function _setWithdrawalPeriod(uint256 withdrawalPeriod_) internal {
        withdrawalPeriod = withdrawalPeriod_;
        emit WithdrawalPeriodUpdate(withdrawalPeriod_);
    }

    function _updateCollateral() internal {
        collateralTokenAddress = symmio.getCollateral();
        collateralTokenDecimals = IERC20Metadata(collateralTokenAddress)
            .decimals();
        require(
            collateralTokenDecimals <= 18,
            "SymmioSolverDepositor: Collateral decimals should be lower than or equal to 18"
        );
    }

    function _setLpTokenAddress(
        address _symmioSolverDepositorTokenAddress
    ) internal {
        require(
            _symmioSolverDepositorTokenAddress != address(0),
            "SymmioSolverDepositor: Zero address"
        );
        lpTokenAddress = _symmioSolverDepositorTokenAddress;
        uint256 lpTokenDecimals = SymmioVaultLpToken(
            _symmioSolverDepositorTokenAddress
        ).decimals();
        require(
            lpTokenDecimals == collateralTokenDecimals,
            "SymmioSolverDepositor: LP token decimals should be the same as collateral token"
        );
    }
}
