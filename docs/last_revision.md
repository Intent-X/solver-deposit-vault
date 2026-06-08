Wallets
Vault Contract
Multisig
Solver PartyB
Broker

Fund split:
SYMM / Buffer Pool / Vittaverse
30/20/50 is the split

Objective:
The Carbon Solver Vault is designed as a secure liquidity provision layer.
Unlike standard models that stake vault tokens in external contracts, this vault handles yield distribution internally, allowing for direct APR (positive or negative) applications based on real-time solver performance.

Core Functionalities
Vault Contract: Acts as the primary custody layer, holding funds temporarily during the deposit phase or while withdrawals are pending.
Roles
Executor: Signs a pending withdrawal as valid or not valid. (Calls approve or reject)
Setter: Sets whitelisted addresses allowed for withdrawals and roles
Rebalancer: Execute withdrawals from Vault to any of the whitelisted addresses.
Do it through a batch withdraw
Signer: User requires a signature of this user before being able to request a withdrawal

Operational Mechanics:
Yield Distribution: Profits are calculated via a backend solution that tracks deposit timing and specific operational fund usage.
Withdrawal Flow: Users request withdrawals, triggering a 2-day deallocation period similar to Ethena to ensure liquidity stability.

Netting Mechanism:
If a user deposits $100 and another user wants to withdraw $100 we would net to 0 and not do the procedures.

UI/UX Improvements:
The system will streamline the user journey by allowing instant internal transfers from the SYMM ecosystem directly into the Carbon Solver Vault using the Instant Withdrawal Bridge. This eliminates the need for manual external withdrawal/deposit steps, providing a seamless experience for users to transition their balances while maintaining vault security through designated Party A address routing.

Services:
