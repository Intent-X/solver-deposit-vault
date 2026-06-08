// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface ISolverVault {
    enum RequestStatus {
        Pending,
        Accepted,
        Rejected,
        Canceled
    }

    struct WithdrawRequest {
        address user;
        address receiver;
        uint256 amount;
        RequestStatus status;
    }

    event Deposit(address indexed depositor, uint256 amount);
    event WithdrawRequested(
        uint256 indexed requestId,
        address indexed user,
        address indexed receiver,
        uint256 amount,
        uint256 nonce
    );
    event WithdrawAccepted(uint256 indexed requestId, address indexed receiver, uint256 amount);
    event WithdrawRejected(uint256 indexed requestId);
    event WithdrawCanceled(uint256 indexed requestId);
    event Rebalanced(address indexed to, uint256 amount);
    event WhitelistUpdated(address indexed account, bool status);
}
