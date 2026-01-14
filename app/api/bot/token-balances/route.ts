import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, type Address, formatUnits } from "viem"
import { base } from "viem/chains"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// BaseScan API base URL
const BASESCAN_API_URL = "https://api.basescan.org/api"

// ERC20 ABI for balanceOf, decimals, symbol, and name
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
  contractAddress: string
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
 * Uses module=account&action=tokentx endpoint
 */
async function fetchTokenListFromBaseScan(address: string): Promise<string[]> {
  try {
    const apiKey = process.env.BASESCAN_API_KEY || ""
    
    // Use tokentx endpoint to get all token transfers to/from this address
    const url = `${BASESCAN_API_URL}?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`
    
    console.log(`📡 BaseScan API: Fetching token transactions for ${address.substring(0, 10)}...`)
    console.log(`   URL: ${url.replace(apiKey, "***")}`)
    
    const response = await fetch(url)
    const data = await response.json()
    
    console.log(`   BaseScan Response status: ${data.status}, message: ${data.message}`)
    
    if (data.status !== "1" || !data.result || !Array.isArray(data.result)) {
      console.log(`   No token transactions found for ${address.substring(0, 10)}...`)
      return []
    }
    
    console.log(`   Found ${data.result.length} token transactions`)
    
    // Extract unique token contract addresses
    const tokenAddresses = new Set<string>()
    for (const tx of data.result as BaseScanTokenTransfer[]) {
      if (tx.contractAddress) {
        tokenAddresses.add(tx.contractAddress.toLowerCase())
      }
    }
    
    console.log(`   Unique tokens: ${tokenAddresses.size}`)
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
    console.log(`   Fetching details for token: ${tokenAddress.substring(0, 10)}...`)
    
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
        continue
      }
    }
    
    // Only return tokens with positive balance
    if (totalBalance <= BigInt(0)) {
      console.log(`   Token ${String(symbol)}: Balance = 0, skipping`)
      return null
    }
    
    const decimalNumber = typeof decimals === "number" ? decimals : Number(decimals)
    const balanceFormatted = formatUnits(totalBalance, decimalNumber)
    
    console.log(`   Token ${String(symbol)}: Balance = ${balanceFormatted}`)
    
    return {
      contractAddress: tokenAddress,
      symbol: String(symbol),
      name: String(name),
      decimals: decimalNumber,
      balance: totalBalance.toString(),
      balanceFormatted: balanceFormatted,
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
 * Uses BaseScan API (module=account&action=tokentx) to discover tokens,
 * then fetches real-time balances from blockchain.
 * 
 * Returns: { success, tokens: [{ contractAddress, symbol, name, decimals, balance, balanceFormatted }] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { botWallets, botWalletAddress } = body as {
      botWallets?: string[]
      botWalletAddress?: string // Optional: fetch for single bot wallet address
    }

    console.log("=====================================")
    console.log("🔍 TOKEN BALANCES API CALLED")
    console.log("=====================================")

    // Support both botWallets array and single botWalletAddress
    let walletAddresses: string[] = []
    
    if (botWalletAddress) {
      // Single bot wallet address (for Manage Bot tab)
      walletAddresses = [botWalletAddress]
      console.log(`📊 Fetching token balances for single bot wallet: ${botWalletAddress}`)
    } else if (botWallets && Array.isArray(botWallets) && botWallets.length > 0) {
      // Multiple bot wallets (for backward compatibility)
      walletAddresses = botWallets
      console.log(`📊 Fetching token balances for ${botWallets.length} bot wallets:`)
      botWallets.forEach((addr, i) => console.log(`   ${i + 1}. ${addr}`))
    } else {
      console.log("❌ Missing botWallets array or botWalletAddress")
      return NextResponse.json(
        { error: "Missing botWallets array or botWalletAddress" },
        { status: 400 }
      )
    }

    // Step 1: Discover all unique tokens across all bot wallets using BaseScan API
    // Uses BASESCAN_API_KEY from environment variables
    console.log(`\n🔍 Step 1: Discovering tokens from BaseScan API (real-time)...`)
    console.log(`   Using BaseScan API Key: ${process.env.BASESCAN_API_KEY ? "✅ Configured" : "❌ Not configured"}`)
    
    const allTokenAddresses = new Set<string>()
    
    // Fetch token list for each bot wallet in parallel using BaseScan API
    const tokenListPromises = walletAddresses.map(async (walletAddress) => {
      return await fetchTokenListFromBaseScan(walletAddress)
    })
    
    const tokenLists = await Promise.all(tokenListPromises)
    
    // Combine all unique token addresses
    for (const tokens of tokenLists) {
      for (const token of tokens) {
        allTokenAddresses.add(token.toLowerCase())
      }
    }
    
    console.log(`\n✅ Discovered ${allTokenAddresses.size} unique tokens from BaseScan API`)
    
    if (allTokenAddresses.size === 0) {
      console.log(`ℹ️ No tokens found in bot wallets (BaseScan API returned no token transactions)`)
      return NextResponse.json({
        success: true,
        tokens: [],
        count: 0,
        message: "No tokens found in bot wallets",
      })
    }

    // Step 2: Fetch real-time balances for each discovered token from blockchain
    console.log(`\n💰 Step 2: Fetching real-time balances for ${allTokenAddresses.size} tokens from blockchain...`)
    
    const tokenDetailsPromises = Array.from(allTokenAddresses).map(async (tokenAddress) => {
      return await fetchTokenDetails(tokenAddress, walletAddresses)
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

    console.log(`\n✅ Found ${validTokens.length} tokens with positive balances:`)
    validTokens.forEach(token => {
      console.log(`   → ${token.symbol} (${token.name}): ${token.balanceFormatted}`)
    })

    const response = {
      success: true,
      tokens: validTokens.map(token => ({
        contractAddress: token.contractAddress,
        address: token.contractAddress, // Alias for compatibility
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        balance: token.balance,
        totalBalance: token.balance, // Alias for compatibility
        balanceFormatted: token.balanceFormatted,
      })),
      count: validTokens.length,
    }

    console.log(`\n📤 Returning response with ${response.count} tokens`)
    console.log("=====================================\n")

    return NextResponse.json(response)
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
