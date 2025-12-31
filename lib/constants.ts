// Token and Contract Addresses on Base Mainnet
export const BUMP_TOKEN_ADDRESS = "0x94ce728849431818ec9a0cf29bdb24fe413bbb07" as const
export const TREASURY_ADDRESS = "0x831204121Dbf75Fd11256a96831E6acD669B4bf6" as const
export const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

// Uniswap V4 PoolManager on Base Mainnet
// PoolManager address: https://docs.verifiedpools.com/security/deployments
export const UNISWAP_V4_POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b" as const

// Uniswap V4 $BUMP/WETH Pool Configuration
// Hook Address for $BUMP pool on Base
export const BUMP_POOL_HOOK_ADDRESS = "0xd60D6B218116cFd801E28F78d011a203D2b068Cc" as const

// Legacy: Uniswap V3 Router (kept for reference)
// Router2 address: https://docs.uniswap.org/contracts/v3/reference/deployments/base
export const UNISWAP_V3_ROUTER2 = "0x2626664c2603336E57B271c5C0b26F42126eED1B" as const

// Token decimals
export const BUMP_DECIMALS = 18
export const WETH_DECIMALS = 18

// Fee percentages (in basis points, where 10000 = 100%)
export const TREASURY_FEE_BPS = 500 // 5% = 500 basis points
export const APP_FEE_BPS = 500 // 5% = 500 basis points
export const USER_CREDIT_BPS = 9000 // 90% = 9000 basis points

