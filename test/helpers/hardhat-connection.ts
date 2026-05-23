import hre from "hardhat"

const connection = await hre.network.getOrCreate()

export const { ethers, networkHelpers } = connection
;(hre as any).ethers = (hre as any).ethers ?? ethers
;(hre as any).networkHelpers = (hre as any).networkHelpers ?? networkHelpers

export { hre }
export default connection
