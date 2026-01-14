import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Route: Record Credit Distribution to Bot Wallets
 * 
 * Records distributed credits from main wallet to bot wallets in database.
 * This ensures credit balance calculation includes bot wallet credits.
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

    // Insert distribution records for each bot wallet
    // Note: distributed_amount_wei stores the original ETH amount (for backward compatibility)
    // weth_balance_wei stores the WETH amount (same value, but explicitly tracked as WETH)
    const records = distributions.map((dist) => ({
      user_address: normalizedUserAddress,
      bot_wallet_address: dist.botWalletAddress.toLowerCase(),
      distributed_amount_wei: dist.amountWei, // Original ETH amount (for backward compatibility)
      weth_balance_wei: dist.wethAmountWei || dist.amountWei, // WETH balance (1:1 with ETH)
      tx_hash: txHash,
    }))

    const { error: insertError } = await supabase
      .from("bot_wallet_credits")
      .insert(records)

    if (insertError) {
      console.error("❌ Error recording distribution:", insertError)
      return NextResponse.json(
        { error: "Failed to record distribution", details: insertError.message },
        { status: 500 }
      )
    }

    console.log(`✅ Recorded ${distributions.length} distribution(s) for user ${normalizedUserAddress}`)

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

