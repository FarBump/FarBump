import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { createPublicClient, http, type Address, formatEther } from "viem"
import { base } from "viem/chains"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Initialize public client for Base
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
})

interface MassFundRequest {
  userAddress: string // Smart Wallet address (sender)
}

/**
 * API Route: Mass Fund - All-In Funding (CDP Compatible)
 * 
 * This route:
 * 1. Gets total ETH balance from user's Smart Wallet
 * 2. Fetches 5 bot wallets from wallets_data table (CDP wallets)
 * 3. Calculates equal distribution (Total / 5) for 5 bot wallets
 * 4. Returns funding instructions for frontend to execute batch transfer
 * 5. Logs system message to bot_logs
 * 
 * IMPORTANT: Actual ETH transfer is done from frontend using Privy Smart Wallet
 * This API only calculates amounts and returns instructions
 */
export async function POST(request: NextRequest) {
  try {
    const body: MassFundRequest = await request.json()
    const { userAddress } = body

    // IMPORTANT: userAddress is the Smart Wallet address from Privy (NOT Embedded Wallet)
    // This is used as the unique identifier (user_address) in all database tables
    // We do NOT use Supabase Auth - only wallet address-based identification

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required field: userAddress" },
        { status: 400 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()

    // Get bot wallets from wallets_data table (CDP wallets)
    const supabase = createSupabaseServiceClient()
    const { data: botWallets, error: fetchError } = await supabase
      .from("wallets_data")
      .select("*")
      .eq("user_address", normalizedUserAddress)
      .order("created_at", { ascending: true })

    if (fetchError || !botWallets) {
      return NextResponse.json(
        { error: "Bot wallets not found. Please create bot wallets first." },
        { status: 404 }
      )
    }

    if (botWallets.length !== 5) {
      return NextResponse.json(
        { error: `Expected 5 bot wallets, but found ${botWallets.length}` },
        { status: 400 }
      )
    }

    // Get total ETH balance from Smart Wallet
    const balanceWei = await publicClient.getBalance({
      address: userAddress as Address,
    })

    // Get real-time ETH price to calculate minimum 0.01 USD in ETH
    let ethPriceUsd: number
    try {
      const priceResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/eth-price`, {
        headers: { Accept: "application/json" },
      })
      if (!priceResponse.ok) {
        throw new Error("Failed to fetch ETH price")
      }
      const priceData = await priceResponse.json()
      if (!priceData.success || typeof priceData.price !== "number") {
        throw new Error("Invalid price data")
      }
      ethPriceUsd = priceData.price
    } catch (priceError: any) {
      console.error("❌ Error fetching ETH price:", priceError)
      return NextResponse.json(
        { error: "Failed to fetch ETH price. Please try again." },
        { status: 500 }
      )
    }

    // Calculate minimum amount: 0.01 USD per wallet
    const MIN_AMOUNT_USD = 0.01
    const minAmountEth = MIN_AMOUNT_USD / ethPriceUsd
    const minAmountWei = BigInt(Math.floor(minAmountEth * 1e18))

    // Calculate total minimum funding needed (5 wallets × 0.01 USD)
    const minTotalFundingWei = minAmountWei * BigInt(5)

    // Check if user has enough balance
    if (balanceWei < minTotalFundingWei) {
      const availableUsd = Number(formatEther(balanceWei)) * ethPriceUsd
      const requiredUsd = MIN_AMOUNT_USD * 5

      return NextResponse.json(
        {
          error: "Insufficient balance for funding",
          details: `You need at least $${requiredUsd.toFixed(2)} USD (${formatEther(minTotalFundingWei)} ETH) to fund 5 bot wallets. Current balance: $${availableUsd.toFixed(2)} USD (${formatEther(balanceWei)} ETH)`,
        },
        { status: 400 }
      )
    }

    // Calculate equal distribution
    const amountPerWalletWei = balanceWei / BigInt(5)
    const amountPerWalletEth = Number(formatEther(amountPerWalletWei))
    const amountPerWalletUsd = amountPerWalletEth * ethPriceUsd

    const totalEth = Number(formatEther(balanceWei))
    const totalUsd = totalEth * ethPriceUsd

    console.log(`💰 Mass Funding Calculation:`)
    console.log(`   Total Balance: ${totalEth} ETH ($${totalUsd.toFixed(2)})`)
    console.log(`   Per Wallet: ${amountPerWalletEth} ETH ($${amountPerWalletUsd.toFixed(2)})`)
    console.log(`   Recipients: ${botWallets.length} wallets`)

    // Create transfer instructions
    const transfers = botWallets.map((wallet, index) => ({
      to: wallet.smart_account_address,
      value: amountPerWalletWei.toString(),
      index: index + 1,
    }))

    // Create individual log entries for each wallet transfer
    const logEntries = transfers.map((transfer, index) => ({
      user_address: normalizedUserAddress,
      action: "funding_transfer",
      message: `[System] Mengirim ${formatEther(BigInt(transfer.value))} ETH ($${amountPerWalletUsd.toFixed(2)}) ke Bot #${index + 1}...`,
      status: "pending",
      timestamp: new Date().toISOString(),
    }))

    // Insert log entries
    const { data: insertedLogs, error: logError } = await supabase
      .from("bot_logs")
      .insert(logEntries)
      .select()

    if (logError) {
      console.error("❌ Failed to create log entries:", logError)
    }

    // Create summary log entry
    await supabase.from("bot_logs").insert({
      user_address: normalizedUserAddress,
      action: "funding_started",
      message: `[System] Funding 5 bots with total ${totalEth.toFixed(6)} ETH ($${totalUsd.toFixed(2)})...`,
      status: "pending",
      timestamp: new Date().toISOString(),
    })

    return NextResponse.json({
      success: true,
      transfers,
      summary: {
        totalEth: totalEth.toFixed(6),
        totalUsd: totalUsd.toFixed(2),
        perWalletEth: amountPerWalletEth.toFixed(6),
        perWalletUsd: amountPerWalletUsd.toFixed(2),
        walletCount: botWallets.length,
      },
      logIds: insertedLogs?.map((log) => log.id) || [],
    })
  } catch (error: any) {
    console.error("❌ Error in mass-fund:", error)
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
