import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { formatUnits } from "viem"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Endpoint: Get Credit Balance
 * 
 * Returns total credit balance for a user:
 * - Main wallet credit (from user_credits table)
 * - Bot wallet credits (from bot_wallet_credits table)
 * 
 * Only counts valid credits from:
 * - Convert $BUMP to credit function
 * - Distribute credit function
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

    // Fetch main wallet credit from database
    const { data: mainCreditData, error: mainCreditError } = await supabase
      .from("user_credits")
      .select("balance_wei, last_updated")
      .eq("user_address", normalizedUserAddress)
      .single()

    // Fetch bot wallet credits from database
    // Include both distributed_amount_wei (ETH) and weth_balance_wei (WETH)
    // Total Credit = Native ETH + WETH (both are 1:1 equivalent)
    const { data: botCreditsData, error: botCreditsError } = await supabase
      .from("bot_wallet_credits")
      .select("distributed_amount_wei, weth_balance_wei")
      .eq("user_address", normalizedUserAddress)

    // Handle errors gracefully
    if (mainCreditError && mainCreditError.code !== "PGRST116") {
      // PGRST116 = no rows returned, which is OK for new users
      console.error("❌ Error fetching main credit balance:", mainCreditError)
      return NextResponse.json(
        { error: "Failed to fetch credit balance", details: mainCreditError.message },
        { status: 500 }
      )
    }

    if (botCreditsError && botCreditsError.code !== "PGRST116") {
      console.error("❌ Error fetching bot credit balance:", botCreditsError)
      return NextResponse.json(
        { error: "Failed to fetch bot credit balance", details: botCreditsError.message },
        { status: 500 }
      )
    }

    // Calculate main wallet credit
    const mainWalletCreditWei = mainCreditData?.balance_wei || "0"
    
    // Calculate bot wallet credits
    // IMPORTANT: Only use weth_balance_wei to avoid double counting
    // distributed_amount_wei is kept for backward compatibility but should not be used in calculation
    // Total Credit = Native ETH (main wallet) + WETH (bot wallets) - both are 1:1 equivalent
    const botWalletCreditsWei = botCreditsData?.reduce((sum, record) => {
      // Use weth_balance_wei only (new WETH-based distributions)
      // Do NOT add distributed_amount_wei to avoid double counting
      // distributed_amount_wei is only for backward compatibility tracking
      const amountWei = record.weth_balance_wei || "0"
      return sum + BigInt(amountWei)
    }, BigInt(0)) || BigInt(0)
    
    // Total credit = Main wallet credit + Bot wallet credits (ETH + WETH)
    const totalCreditWei = BigInt(mainWalletCreditWei) + botWalletCreditsWei
    const balanceWei = totalCreditWei.toString()
    const balanceEth = formatUnits(BigInt(balanceWei), 18)

    return NextResponse.json({
      success: true,
      balanceWei,
      balanceEth,
      mainWalletCreditWei,
      botWalletCreditsWei: botWalletCreditsWei.toString(),
      lastUpdated: mainCreditData?.last_updated || null,
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

