import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Route: Record Credit Distribution to Bot Wallets
 * 
 * Records distributed credits from main wallet to bot wallets in database.
 * This ensures credit balance calculation includes bot wallet credits.
 * 
 * IMPORTANT: 
 * - Only uses weth_balance_wei for credit tracking (distributed_amount_wei removed)
 * - Uses UPSERT to ensure only 1 row per bot_wallet_address
 * - If record exists, adds to existing weth_balance_wei
 * - If record doesn't exist, creates new record with weth_balance_wei
 * - Credit value is 1:1 (WETH = ETH in terms of credit calculation)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress, distributions, txHash } = body as {
      userAddress: string
      distributions: Array<{ botWalletAddress: string; amountWei: string; wethAmountWei?: string }>
      txHash: string
    }

    if (!userAddress || !distributions || !txHash) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, distributions, txHash" },
        { status: 400 }
      )
    }

    if (!Array.isArray(distributions) || distributions.length === 0) {
      return NextResponse.json(
        { error: "distributions must be a non-empty array" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()
    const normalizedUserAddress = userAddress.toLowerCase()

    // Upsert distribution records for each bot wallet
    // IMPORTANT: Only 1 row per bot_wallet_address (unique constraint)
    // If record exists, add to existing weth_balance_wei
    // If record doesn't exist, create new record with weth_balance_wei
    // 
    // CREDIT SYSTEM (1:1 Value):
    // - Only weth_balance_wei is used for credit tracking
    // - Total Credit = Native ETH (main wallet) + WETH (bot wallets)
    // - Credit value is 1:1 (WETH = ETH in terms of credit calculation)
    // 
    // WHY WETH?
    // - Bot wallets hold WETH instead of Native ETH for gasless transactions
    // - WETH can be directly used in Uniswap v4 swaps without unwrapping
    // - Paymaster Coinbase allows ERC20 (WETH) transfers that were rejected for Native ETH
    
    for (const dist of distributions) {
      const botWalletAddress = dist.botWalletAddress.toLowerCase()
      const wethAmountWei = dist.wethAmountWei || dist.amountWei
      
      // Check if record exists
      const { data: existingRecord } = await supabase
        .from("bot_wallet_credits")
        .select("weth_balance_wei")
        .eq("user_address", normalizedUserAddress)
        .eq("bot_wallet_address", botWalletAddress)
        .single()
      
      if (existingRecord) {
        // Update existing record: add to existing weth_balance_wei
        const currentBalance = BigInt(existingRecord.weth_balance_wei || "0")
        const newBalance = currentBalance + BigInt(wethAmountWei)
        
        const { error: updateError } = await supabase
          .from("bot_wallet_credits")
          .update({
            weth_balance_wei: newBalance.toString(),
            tx_hash: txHash, // Update tx_hash to most recent
          })
          .eq("user_address", normalizedUserAddress)
          .eq("bot_wallet_address", botWalletAddress)
        
        if (updateError) {
          console.error(`❌ Error updating distribution for ${botWalletAddress}:`, updateError)
          return NextResponse.json(
            { error: "Failed to update distribution", details: updateError.message },
            { status: 500 }
          )
        }
      } else {
        // Insert new record
        const { error: insertError } = await supabase
          .from("bot_wallet_credits")
          .insert({
            user_address: normalizedUserAddress,
            bot_wallet_address: botWalletAddress,
            weth_balance_wei: wethAmountWei,
            tx_hash: txHash,
          })
        
        if (insertError) {
          console.error(`❌ Error inserting distribution for ${botWalletAddress}:`, insertError)
          return NextResponse.json(
            { error: "Failed to record distribution", details: insertError.message },
            { status: 500 }
          )
        }
      }
    }

    if (insertError) {
      console.error("❌ Error recording distribution:", insertError)
      return NextResponse.json(
        { error: "Failed to record distribution", details: insertError.message },
        { status: 500 }
      )
    }

    console.log(`✅ Recorded ${distributions.length} distribution(s) for user ${normalizedUserAddress}`)
    console.log(`   → Used UPSERT: Updated existing records or created new ones`)
    console.log(`   → Only weth_balance_wei is used for credit tracking`)

    return NextResponse.json({
      success: true,
      message: "Distribution recorded successfully",
      recordsCount: distributions.length,
    })
  } catch (error: any) {
    console.error("❌ Error in record-distribution API:", error)
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

