// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockSymmio {
    // Use SafeERC20 for safer token transfers
    using SafeERC20 for IERC20;

    address public collateral;
    mapping(address => uint256) public balances;
    mapping(address => uint256) public allocatedBalances;

    constructor(address _collateral) {
        collateral = _collateral;
    }

    function getCollateral() external view returns (address) {
        return collateral;
    }

    function depositFor(address partyB, uint256 amount) external {
        IERC20(collateral).transferFrom(msg.sender, address(this), amount);
        balances[partyB] += amount;
    }

    function balanceOf(address partyB) external view returns (uint256) {
        return balances[partyB];
    }

    function allocatedBalanceOfPartyA(address partyA) external view returns (uint256) {
        return allocatedBalances[partyA];
    }

    /// @notice Mirrors Symmio's account-layer internalTransfer: the caller is the source
    /// sub-account; here we just credit the recipient's allocated balance to simulate the credit.
    function internalTransfer(address user, uint256 amount) external {
        allocatedBalances[user] += amount;
    }
}
