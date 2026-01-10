import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { createPublicClient, http, type Address, formatEther, parseEther } from "viem"
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
 * API Route: Mass Fund - All-In Funding
 * 
 * This route:
 * 1. Gets total ETH balance from user's Smart Wallet
 * 2. Calculates equal distribution (Total / 5) for 5 bot wallets
 * 3. Returns funding instructions for frontend to execute batch transfer
 * 4. Logs system message to bot_logs
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

    // Get bot wallets from database
    const supabase = createSupabaseServiceClient()
    const { data: botWalletsData, error: fetchError } = await supabase
      .from("user_bot_wallets")
      .select("wallets_data")
      .eq("user_address", normalizedUserAddress)
      .single()

    if (fetchError || !botWalletsData) {
      return NextResponse.json(
        { error: "Bot wallets not found. Please create bot wallets first." },
        { status: 404 }
      )
    }

    const wallets = botWalletsData.wallets_data as Array<{
      smart_account_address: Address
      owner_public_address: Address
      owner_private_key: string
      chain: string
    }>

    if (!wallets || wallets.length !== 5) {
      return NextResponse.json(
        { error: "Expected 5 bot wallets, but found " + (wallets?.length || 0) },
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

    // Calculate minimum 0.01 USD in ETH with high precision (18 decimals)
    // PENTING: Gunakan pembulatan angka yang aman (6-18 desimal di belakang koma untuk ETH)
    const MIN_AMOUNT_USD = 0.01
    const minAmountEth = MIN_AMOUNT_USD / ethPriceUsd
    // Convert to wei with full precision (18 decimals)
    const minAmountWei = BigInt(Math.floor(minAmountEth * 1e18))
    
    // Reserve minimal 0.01 USD worth of ETH for gas (if not using Paymaster)
    // If using Paymaster, we can send almost all balance, but still keep minimal reserve for safety
    const GAS_RESERVE = minAmountWei // Use 0.01 USD worth of ETH as reserve
    const availableBalance = balanceWei > GAS_RESERVE 
      ? balanceWei - GAS_RESERVE 
      : BigInt(0)

    // Validate minimum balance: at least 0.01 USD per wallet (5 wallets = 0.05 USD minimum)
    const MIN_TOTAL_FUNDING_USD = MIN_AMOUNT_USD * 5 // 0.05 USD total for 5 wallets
    const minTotalFundingEth = MIN_TOTAL_FUNDING_USD / ethPriceUsd
    const minTotalFundingWei = BigInt(Math.floor(minTotalFundingEth * 1e18))

    if (availableBalance < minTotalFundingWei) {
      const balanceEth = Number(availableBalance) / 1e18
      const balanceUsd = balanceEth * ethPriceUsd
      return NextResponse.json(
        { 
          error: `Insufficient balance. Minimum $${MIN_TOTAL_FUNDING_USD.toFixed(2)} (${minTotalFundingEth.toFixed(6)} ETH) required for funding 5 bot wallets. Available: $${balanceUsd.toFixed(2)} (${balanceEth.toFixed(6)} ETH)`,
        },
        { status: 400 }
      )
    }

    // Calculate equal distribution per wallet (divide by 5)
    const amountPerWallet = availableBalance / BigInt(5)
    const totalFunding = amountPerWallet * BigInt(5)

    // Prepare batch transfer instructions with individual wallet logs
    // Sinkronisasi Live Activity Log: Log setiap tahap pengiriman Credit (ETH)
    const transfers = wallets.map((wallet, index) => ({
      to: wallet.smart_account_address as Address,
      value: amountPerWallet,
      walletIndex: index,
    }))

    // Log individual transfers for each wallet (will be updated with tx_hash after batch transaction completes)
    // Format: [System] Mengirim 0.000003 ETH ($0.01) ke Bot #1... Berhasil
    const amountPerWalletEth = formatEther(amountPerWallet)
    const amountPerWalletUsd = (Number(amountPerWallet) / 1e18) * ethPriceUsd
    
    // Create logs for each wallet transfer
    const walletLogPromises = transfers.map(async (transfer, index) => {
      const walletEth = formatEther(transfer.value)
      const walletUsd = (Number(transfer.value) / 1e18) * ethPriceUsd
      return supabase.from("bot_logs").insert({
        user_address: normalizedUserAddress,
        wallet_address: transfer.to,
        token_address: null, // Funding, not token swap
        amount_wei: transfer.value.toString(),
        status: "pending",
        message: `[System] Mengirim ${walletEth} ETH ($${walletUsd.toFixed(2)}) ke Bot #${index + 1}...`,
        tx_hash: null, // Will be filled after batch transaction completes
      }).select("id").single()
    })
    
    const walletLogsResults = await Promise.all(walletLogPromises)
    const walletLogIds = walletLogsResults.map(log => log.data?.id).filter(Boolean)
    
    // Also create main summary log
    const totalEth = formatEther(totalFunding)
    const totalUsd = (Number(totalFunding) / 1e18) * ethPriceUsd
    const logResult = await supabase.from("bot_logs").insert({
      user_address: normalizedUserAddress,
      wallet_address: null, // System message, no specific wallet
      token_address: null, // System message
      amount_wei: totalFunding.toString(),
      status: "pending",
      message: `[System] Funding 5 bots with total ${totalEth} ETH ($${totalUsd.toFixed(2)})... Pending`,
      tx_hash: null, // Will be filled after batch transaction completes
    }).select("id").single()
    
    const systemLogId = logResult.data?.id

    console.log(`✅ Mass funding prepared for user: ${userAddress}`)
    console.log(`   Total balance: ${formatEther(balanceWei)} ETH`)
    console.log(`   Available for funding: ${formatEther(availableBalance)} ETH`)
    console.log(`   Amount per wallet: ${formatEther(amountPerWallet)} ETH`)
    console.log(`   Total funding: ${formatEther(totalFunding)} ETH`)

    return NextResponse.json({
      success: true,
      totalBalance: balanceWei.toString(),
      availableBalance: availableBalance.toString(),
      amountPerWallet: amountPerWallet.toString(),
      totalFunding: totalFunding.toString(),
      transfers: transfers.map(t => ({
        to: t.to,
        value: t.value.toString(),
        walletIndex: t.walletIndex,
      })),
      systemLogId: systemLogId, // Return log ID so frontend can update with tx_hash
      walletLogIds: walletLogIds, // Return wallet log IDs so frontend can update with tx_hash
      message: `Prepared ${formatEther(totalFunding)} ETH ($${((Number(totalFunding) / 1e18) * ethPriceUsd).toFixed(2)}) for distribution to 5 bot wallets`,
    })
  } catch (error: any) {
    console.error("❌ Error in mass-fund:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

