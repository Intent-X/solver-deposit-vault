// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IMockSymmioCredit {
    function internalTransfer(address user, uint256 amount) external;
}

contract MockMultiAccount {
    address public symmio;
    mapping(address => address) public owners;

    // 0 = credit exact amount, 1 = credit nothing, 2 = credit double the amount
    uint8 public creditMode;

    constructor(address _symmio) {
        symmio = _symmio;
    }

    function setOwner(address subAccount, address owner) external {
        owners[subAccount] = owner;
    }

    function setCreditMode(uint8 _creditMode) external {
        creditMode = _creditMode;
    }

    function _call(address, bytes[] calldata _callDatas) external {
        require(_callDatas.length == 1, "MockMultiAccount: expected single call");
        bytes calldata callData = _callDatas[0];
        require(callData.length >= 4, "MockMultiAccount: call data too short");

        // Decode internalTransfer(address user, uint256 amount) ignoring the 4-byte selector.
        (address user, uint256 amount) = abi.decode(callData[4:], (address, uint256));

        if (creditMode == 1) {
            // credit nothing
        } else if (creditMode == 2) {
            IMockSymmioCredit(symmio).internalTransfer(user, amount * 2);
        } else {
            IMockSymmioCredit(symmio).internalTransfer(user, amount);
        }
    }
}
