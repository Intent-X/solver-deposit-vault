import { networkHelpers } from "./hardhat-connection.js"

export const time = {
	increase: async (seconds: bigint | number) => networkHelpers.time.increase(seconds),
	latest: async () => networkHelpers.time.latest(),
}
