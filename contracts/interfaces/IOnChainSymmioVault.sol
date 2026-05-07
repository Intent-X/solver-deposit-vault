// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

interface IOnChainSymmioVault {
    struct WithdrawRequest {
        address receiver;
        address sender;
        uint256 amount;
        uint256 minAmountOut;
        RequestStatus status;
        uint256 acceptedAmount;
        uint256 acceptedWithdrawRequestTimestamp;
        uint256 claimableAt;
    }

    enum RequestStatus {
        Pending,
        Ready,
        Done,
        Canceled,
        Rejected
    }

    event WithdrawalPeriodUpdate(uint256 withdrawalPeriod);

    event Deposit(address indexed depositor, uint256 amount);
    event WithdrawRequestEvent(
        uint256 indexed requestId, address indexed sender, address indexed receiver, uint256 amount, uint256 nonce
    );
    event WithdrawRequestCanceled(uint256 indexed requestId);
    event WithdrawRequestRejected(uint256 indexed requestId);
    event WithdrawRequestAcceptedEvent(uint256 providedAmount, uint256[] acceptedRequestIds, uint256[] _acceptedAmounts);
    event WithdrawClaimedEvent(uint256 indexed requestId, address indexed receiver);
    event SymmioAddressUpdatedEvent(address indexed newSymmioAddress);
    event DepositLimitUpdatedEvent(uint256 depositLimit);
    event MinimumPaybackRatioUpdatedEvent(uint256 minimumPaybackRatio);
    event SolverUpdatedEvent(address indexed solver);
    event DepositToSymmio(address indexed depositor, address indexed solver, uint256 amount);
    event SignerUpdatedEvent(address indexed signer);
    event MultiAccountUpdatedEvent(address multiAccount);
    event SolverSubAccountUpdatedEvent(address solverSubAccount);
    event DepositViaInternalTransfer(address indexed user, address indexed subAccount, uint256 amount);

    // ---------------------------------------------------------------------
    // Functions
    // ---------------------------------------------------------------------
    // The pre-existing interface declared events/structs/enums only (no
    // function signatures). The new internal-transfer deposit pathway is
    // declared here in a clearly delimited section to keep the contract's
    // external surface discoverable from the interface.

    /// @notice Alternative deposit pathway. Moves collateral already held by the
    ///         user inside Symmio (under one of their MultiAccount sub-accounts)
    ///         into the solver's allocated balance via MultiAccount delegated
    ///         `internalTransfer`. See `docs/internal-transfer-deposit.md`.
    /// @param subAccount The user's MultiAccount sub-account holding the deposited
    ///                   balance to be transferred.
    /// @param amount     The amount of collateral to internally transfer to the
    ///                   solver sub-account (in collateral-token decimals).
    function depositViaInternalTransfer(address subAccount, uint256 amount) external;
}