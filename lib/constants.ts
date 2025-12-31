// Token and Contract Addresses on Base Mainnet
export const BUMP_TOKEN_ADDRESS = "0x94ce728849431818ec9a0cf29bdb24fe413bbb07" as const
export const TREASURY_ADDRESS = "0x831204121Dbf75Fd11256a96831E6acD669B4bf6" as const
export const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

// Uniswap V4 PoolManager on Base Mainnet
// PoolManager address: https://docs.verifiedpools.com/security/deployments
export const UNISWAP_V4_POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b" as const

// Uniswap Universal Router on Base Mainnet
export const UNISWAP_UNIVERSAL_ROUTER = "0x6fF5693b99212Da76ad316178A184AB56D299b43" as const

// Permit2 on Base Mainnet
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const

// Uniswap V4 $BUMP/WETH Pool Configuration
// PoolKey details:
// currency0: WETH (0x4200000000000000000000000000000000000006)
// currency1: $BUMP (0x94CE728849431818EC9a0CF29BDb24FE413bBb07)
// fee: 8388608 (Dynamic Fee)
// tickSpacing: 200
// hooks: 0xd60D6B218116cFd801E28F78d011a203D2b068Cc
export const BUMP_POOL_HOOK_ADDRESS = "0xd60D6B218116cFd801E28F78d011a203D2b068Cc" as const
export const BUMP_POOL_CURRENCY0 = "0x4200000000000000000000000000000000000006" as const // WETH
export const BUMP_POOL_CURRENCY1 = "0x94CE728849431818EC9a0CF29BDb24FE413bBb07" as const // $BUMP
export const BUMP_POOL_FEE = 8388608 // Dynamic Fee (0x800000)
export const BUMP_POOL_TICK_SPACING = 200

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

