import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { formatUnits, createPublicClient, http, type Address } from "viem"
import { base } from "viem/chains"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Endpoint: Get Credit Balance
 * 
 * Returns total credit balance for a user:
 * - Main wallet credit: Actual ETH + WETH balance in smart wallet (on-chain)
 * - Bot wallet credits: Sum of weth_balance_wei from database
 * 
 * IMPORTANT CHANGE:
 * - Main wallet credit is now fetched from blockchain (actual balance)
 * - This ensures credit decreases naturally when distributing to bot wallets
 * - user_credits.balance_wei is kept for audit/history but NOT used for display
 * 
 * Credit Display Formula:
 * Total Credit (USD) = (Main Wallet ETH + Main Wallet WETH + Bot Wallets WETH) × ETH Price
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress } = body as { userAddress: string }

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required field: userAddress" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()
    const normalizedUserAddress = userAddress.toLowerCase()

    // Initialize blockchain client for fetching actual balances
    const publicClient = createPublicClient({
      chain: base,
      transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
    })

    // WETH Contract on Base
    const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const
    const WETH_ABI = [
      {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const

    // Fetch ACTUAL ETH + WETH balance from blockchain (main smart wallet)
    console.log(`\n💰 Fetching actual balance for ${normalizedUserAddress}...`)
    
    let nativeEthBalance = BigInt(0)
    let wethBalance = BigInt(0)
    
    try {
      // Get Native ETH balance
      nativeEthBalance = await publicClient.getBalance({
        address: normalizedUserAddress as Address,
      })
      
      // Get WETH balance
      wethBalance = await publicClient.readContract({
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "balanceOf",
        args: [normalizedUserAddress as Address],
      }) as bigint
      
      console.log(`   → Native ETH: ${formatUnits(nativeEthBalance, 18)} ETH`)
      console.log(`   → WETH: ${formatUnits(wethBalance, 18)} WETH`)
    } catch (balanceError: any) {
      console.error("❌ Error fetching on-chain balance:", balanceError.message)
      // Continue with 0 balance instead of failing completely
    }

    // Main wallet credit = Actual ETH + WETH in wallet (on-chain)
    const mainWalletCreditWei = nativeEthBalance + wethBalance

    // Fetch bot wallet credits from database
    // IMPORTANT: Only 1 row per bot_wallet_address, only weth_balance_wei is used
    const { data: botCreditsData, error: botCreditsError } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei")
      .eq("user_address", normalizedUserAddress)

    if (botCreditsError && botCreditsError.code !== "PGRST116") {
      console.error("❌ Error fetching bot credit balance:", botCreditsError)
      return NextResponse.json(
        { error: "Failed to fetch bot credit balance", details: botCreditsError.message },
        { status: 500 }
      )
    }

    // Calculate bot wallet credits (from database)
    const botWalletCreditsWei = botCreditsData?.reduce((sum, record) => {
      const amountWei = BigInt(record.weth_balance_wei || "0")
      return sum + amountWei
    }, BigInt(0)) || BigInt(0)
    
    console.log(`   → Bot Wallets WETH (DB): ${formatUnits(botWalletCreditsWei, 18)} WETH`)
    
    // Total credit = Main wallet (ETH + WETH on-chain) + Bot wallets WETH (from DB)
    const totalCreditWei = mainWalletCreditWei + botWalletCreditsWei
    const balanceWei = totalCreditWei.toString()
    const balanceEth = formatUnits(BigInt(balanceWei), 18)
    
    console.log(`   → Total Credit: ${balanceEth} ETH`)

    return NextResponse.json({
      success: true,
      balanceWei,
      balanceEth,
      mainWalletCreditWei: mainWalletCreditWei.toString(),
      botWalletCreditsWei: botWalletCreditsWei.toString(),
      lastUpdated: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error("❌ Error in credit-balance API:", error)
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

