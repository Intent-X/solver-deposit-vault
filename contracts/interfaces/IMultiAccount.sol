// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity ^0.8.19;

interface IMultiAccount {
    function owners(address account) external view returns (address);

    function _call(address account, bytes[] calldata _callDatas) external;
}
