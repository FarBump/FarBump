import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Endpoint: Get WETH Balance for a Specific Bot Wallet
 * 
 * Returns the total WETH balance for a specific bot wallet from database.
 * Used to check if bot wallet has sufficient WETH before starting swap.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress, botWalletAddress } = body as {
      userAddress: string
      botWalletAddress: string
    }

    if (!userAddress || !botWalletAddress) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, botWalletAddress" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()
    const normalizedUserAddress = userAddress.toLowerCase()
    const normalizedBotWalletAddress = botWalletAddress.toLowerCase()

    // Fetch WETH balance from database for this specific bot wallet
    const { data: creditRecords, error: fetchError } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei, distributed_amount_wei")
      .eq("user_address", normalizedUserAddress)
      .eq("bot_wallet_address", normalizedBotWalletAddress)

    if (fetchError) {
      console.error("❌ Error fetching bot wallet WETH balance:", fetchError)
      return NextResponse.json(
        { error: "Failed to fetch bot wallet WETH balance", details: fetchError.message },
        { status: 500 }
      )
    }

    // Calculate total WETH balance for this bot wallet
    // Use weth_balance_wei if available, otherwise fallback to distributed_amount_wei
    const wethBalanceWei = creditRecords?.reduce((sum, record) => {
      const amountWei = record.weth_balance_wei || record.distributed_amount_wei || "0"
      return sum + BigInt(amountWei)
    }, BigInt(0)) || BigInt(0)

    return NextResponse.json({
      success: true,
      wethBalanceWei: wethBalanceWei.toString(),
      botWalletAddress: normalizedBotWalletAddress,
    })
  } catch (error: any) {
    console.error("❌ Error in wallet-weth-balance API:", error)
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

