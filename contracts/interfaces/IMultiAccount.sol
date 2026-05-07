// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title IMultiAccount
/// @notice Minimal subset of the perps-core MultiAccount surface consumed by the vault.
/// @dev Mirrors contracts/helpers/accounts/MultiAccount.sol on perps-core ref `origin/version_0.8.5`.
///      Only members the vault needs are declared; struct definitions and admin-only
///      functions from MultiAccount are intentionally omitted.
interface IMultiAccount {
    /// @notice Returns the owner of a given sub-account address.
    /// @dev Auto-getter for the public mapping `mapping(address => address) public owners`.
    ///      Cites contracts/helpers/accounts/MultiAccount.sol:30 on perps-core version_0.8.5.
    /// @param account The sub-account address to look up.
    /// @return The owner address registered for `account`, or address(0) if unknown.
    function owners(address account) external view returns (address);

    /// @notice Executes a series of calls on behalf of the specified sub-account.
    /// @dev Cites contracts/helpers/accounts/MultiAccount.sol:257 on perps-core version_0.8.5.
    ///      The unusual leading underscore on this external entrypoint is intentional in
    ///      perps-core 0.8.5: the function is declared `public` (so externally callable)
    ///      and is the documented call path used both by account owners and by delegated
    ///      callers (the vault holds delegateAccess and reaches Symmio through this).
    ///      The implementation returns `bytes[] memory` per call result; this interface
    ///      mirrors that signature so call sites may consume or ignore the returned data.
    /// @param account The sub-account to execute the calls on behalf of.
    /// @param _callDatas The ABI-encoded call data array to forward to the sub-account.
    /// @return results The per-call return data from each forwarded invocation.
    function _call(address account, bytes[] memory _callDatas) external returns (bytes[] memory results);
}
