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

    // Reserve 0.001 ETH for gas estimation (if not using Paymaster)
    // If using Paymaster, can send almost all balance
    const GAS_RESERVE = parseEther("0.001") // Reserve for potential gas costs
    const availableBalance = balanceWei > GAS_RESERVE 
      ? balanceWei - GAS_RESERVE 
      : BigInt(0)

    if (availableBalance <= BigInt(0)) {
      return NextResponse.json(
        { error: "Insufficient balance. Minimum 0.001 ETH required for gas reserve." },
        { status: 400 }
      )
    }

    // Calculate equal distribution per wallet (divide by 5)
    const amountPerWallet = availableBalance / BigInt(5)
    const totalFunding = amountPerWallet * BigInt(5)

    // Prepare batch transfer instructions
    const transfers = wallets.map((wallet, index) => ({
      to: wallet.smart_account_address as Address,
      value: amountPerWallet,
      walletIndex: index,
    }))

    // Log system message to bot_logs (will be updated with tx_hash after batch transaction completes)
    // Frontend will update this log entry with the actual transaction hash
    const totalEth = formatEther(totalFunding)
    const logResult = await supabase.from("bot_logs").insert({
      user_address: normalizedUserAddress,
      wallet_address: null, // System message, no specific wallet
      token_address: null, // System message
      amount_wei: totalFunding.toString(),
      status: "pending",
      message: `[System] Mengirim seluruh saldo Credit (${totalEth} ETH) secara merata ke 5 bot wallets`,
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
      message: `Prepared ${formatEther(totalFunding)} ETH for distribution to 5 bot wallets`,
    })
  } catch (error: any) {
    console.error("❌ Error in mass-fund:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

