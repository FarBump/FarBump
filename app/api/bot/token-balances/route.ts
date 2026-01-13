import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, type Address, formatUnits } from "viem"
import { base } from "viem/chains"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// BaseScan API base URL
const BASESCAN_API_URL = "https://api.basescan.org/api"

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
  {
    constant: true,
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    type: "function",
  },
] as const

// Public client for blockchain queries
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

interface TokenBalance {
  address: string
  symbol: string
  name: string
  decimals: number
  balance: string
  balanceFormatted: string
}

interface BaseScanTokenTransfer {
  contractAddress: string
  tokenName: string
  tokenSymbol: string
  tokenDecimal: string
  value: string
}

/**
 * Fetch token list from BaseScan API (tokens transferred to this address)
 * This gives us a list of all ERC20 tokens that the address has ever received
 */
async function fetchTokenListFromBaseScan(address: string): Promise<string[]> {
  try {
    const apiKey = process.env.BASESCAN_API_KEY || ""
    
    // Use tokentx endpoint to get all token transfers to this address
    const url = `${BASESCAN_API_URL}?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`
    
    console.log(`📡 Fetching token transactions for ${address.substring(0, 10)}...`)
    
    const response = await fetch(url)
    const data = await response.json()
    
    if (data.status !== "1" || !data.result || !Array.isArray(data.result)) {
      console.log(`   No token transactions found for ${address.substring(0, 10)}...`)
      return []
    }
    
    // Extract unique token contract addresses
    const tokenAddresses = new Set<string>()
    for (const tx of data.result as BaseScanTokenTransfer[]) {
      if (tx.contractAddress) {
        tokenAddresses.add(tx.contractAddress.toLowerCase())
      }
    }
    
    console.log(`   Found ${tokenAddresses.size} unique tokens for ${address.substring(0, 10)}...`)
    return Array.from(tokenAddresses)
  } catch (error: any) {
    console.error(`❌ BaseScan API error for ${address}:`, error.message)
    return []
  }
}

/**
 * Fetch token balance and metadata from blockchain
 */
async function fetchTokenDetails(
  tokenAddress: string,
  walletAddresses: string[]
): Promise<TokenBalance | null> {
  try {
    // Fetch token metadata
    const [symbol, name, decimals] = await Promise.all([
      publicClient.readContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        functionName: "symbol",
      }).catch(() => "UNKNOWN"),
      publicClient.readContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        functionName: "name",
      }).catch(() => "Unknown Token"),
      publicClient.readContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        functionName: "decimals",
      }).catch(() => 18),
    ])
    
    // Fetch balance for all wallet addresses
    let totalBalance = BigInt(0)
    
    for (const walletAddress of walletAddresses) {
      try {
        const balance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress as Address],
        }) as bigint
        totalBalance += balance
      } catch (error) {
        // Skip this wallet if balance fetch fails
        continue
      }
    }
    
    // Only return tokens with positive balance
    if (totalBalance <= BigInt(0)) {
      return null
    }
    
    const decimalNumber = typeof decimals === "number" ? decimals : Number(decimals)
    
    return {
      address: tokenAddress,
      symbol: String(symbol),
      name: String(name),
      decimals: decimalNumber,
      balance: totalBalance.toString(),
      balanceFormatted: formatUnits(totalBalance, decimalNumber),
    }
  } catch (error: any) {
    console.warn(`⚠️ Failed to fetch details for token ${tokenAddress}:`, error.message)
    return null
  }
}

/**
 * API Route: Get Token Balances for Bot Wallets
 * 
 * Fetches ERC20 token balances for multiple bot wallets.
 * Uses BaseScan API to discover tokens, then fetches real-time balances from blockchain.
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
    console.log(`   Bot wallets:`, botWallets.map((addr, i) => `${i + 1}. ${addr.substring(0, 10)}...`).join(", "))

    // Step 1: Discover all unique tokens across all bot wallets using BaseScan
    console.log(`🔍 Discovering tokens from BaseScan...`)
    
    const allTokenAddresses = new Set<string>()
    
    // Fetch token list for each bot wallet in parallel
    const tokenListPromises = botWallets.map(async (walletAddress) => {
      const tokens = await fetchTokenListFromBaseScan(walletAddress)
      return tokens
    })
    
    const tokenLists = await Promise.all(tokenListPromises)
    
    // Combine all unique token addresses
    for (const tokens of tokenLists) {
      for (const token of tokens) {
        allTokenAddresses.add(token.toLowerCase())
      }
    }
    
    console.log(`✅ Discovered ${allTokenAddresses.size} unique tokens across all bot wallets`)
    
    if (allTokenAddresses.size === 0) {
      console.log(`ℹ️ No tokens found in bot wallets`)
      return NextResponse.json({
        success: true,
        tokens: [],
        count: 0,
        message: "No tokens found in bot wallets",
      })
    }

    // Step 2: Fetch real-time balances for each discovered token
    console.log(`💰 Fetching real-time balances for ${allTokenAddresses.size} tokens...`)
    
    const tokenDetailsPromises = Array.from(allTokenAddresses).map(async (tokenAddress) => {
      return await fetchTokenDetails(tokenAddress, botWallets)
    })
    
    const tokenDetails = await Promise.all(tokenDetailsPromises)
    
    // Filter out null results (tokens with zero balance)
    const validTokens = tokenDetails.filter((token): token is TokenBalance => token !== null)
    
    // Sort by balance (highest first)
    validTokens.sort((a, b) => {
      const balanceA = BigInt(a.balance)
      const balanceB = BigInt(b.balance)
      return balanceB > balanceA ? 1 : balanceB < balanceA ? -1 : 0
    })

    console.log(`✅ Found ${validTokens.length} tokens with positive balances`)
    
    // Log token details for debugging
    for (const token of validTokens) {
      console.log(`   → ${token.symbol}: ${token.balanceFormatted} (${token.name})`)
    }

    return NextResponse.json({
      success: true,
      tokens: validTokens.map(token => ({
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        totalBalance: token.balance,
        balanceFormatted: token.balanceFormatted,
      })),
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
