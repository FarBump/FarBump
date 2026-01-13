import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, type Address } from "viem"
import { base } from "viem/chains"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// ERC20 ABI for balanceOf, decimals, and symbol
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    type: "function",
  },
] as const

// Public client for blockchain queries
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

// Common Base tokens to check (can be expanded)
const COMMON_BASE_TOKENS: Array<{ address: string; symbol: string; decimals: number }> = [
  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", symbol: "USDbC", decimals: 6 },
  { address: "0x78a087d713Be963Bf307b18F2Ff8122EF9A63ae9", symbol: "BRETT", decimals: 18 },
  { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", decimals: 18 },
]

/**
 * API Route: Get Token Balances for Bot Wallets
 * 
 * Fetches ERC20 token balances for multiple bot wallets in batch.
 * Returns aggregated balances (sum across all bot wallets) for each token.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { botWallets } = body as {
      botWallets: string[]
    }

    if (!botWallets || !Array.isArray(botWallets) || botWallets.length === 0) {
      return NextResponse.json(
        { error: "Missing or invalid botWallets array" },
        { status: 400 }
      )
    }

    console.log(`📊 Fetching token balances for ${botWallets.length} bot wallets...`)

    const tokenBalances: Array<{
      address: string
      symbol: string
      decimals: number
      totalBalance: string
    }> = []

    // Check balances for each common token across all bot wallets
    // Use Promise.all for parallel fetching (faster)
    const tokenPromises = COMMON_BASE_TOKENS.map(async (token) => {
      let totalBalance = BigInt(0)
      let hasBalance = false

      // Fetch balances for all bot wallets in parallel
      const balancePromises = botWallets.map(async (botWalletAddress) => {
        try {
          const balance = await publicClient.readContract({
            address: token.address as Address,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [botWalletAddress as Address],
          })

          const balanceBigInt = BigInt(balance.toString())
          if (balanceBigInt > BigInt(0)) {
            hasBalance = true
            totalBalance += balanceBigInt
          }
          return balanceBigInt
        } catch (error) {
          // Token might not exist or contract might not support balanceOf
          console.warn(`Failed to fetch balance for ${token.symbol} in ${botWalletAddress}:`, error)
          return BigInt(0)
        }
      })

      await Promise.all(balancePromises)

      // Only include tokens with non-zero total balance
      if (hasBalance && totalBalance > BigInt(0)) {
        return {
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          totalBalance: totalBalance.toString(),
        }
      }

      return null
    })

    const results = await Promise.all(tokenPromises)
    const validTokens = results.filter((token): token is NonNullable<typeof token> => token !== null)

    console.log(`✅ Found ${validTokens.length} tokens with balances`)

    return NextResponse.json({
      success: true,
      tokens: validTokens,
      count: validTokens.length,
    })
  } catch (error: any) {
    console.error("❌ Error in token-balances API:", error)
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      },
      { status: 500 }
    )
  }
}

