import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { type Address } from "viem"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface StartSessionRequest {
  userAddress: string
  tokenAddress: Address
  amountUsd: string // USD amount per bump (will be converted to ETH/Wei using real-time price)
  intervalSeconds: number // Interval in seconds (2-600) - Bot runs continuously until stopped
}

/**
 * POST /api/bot/session - Start a new bot session
 * 
 * Creates a new bot session in bot_sessions table.
 * Ensures only one active session per user.
 */
export async function POST(request: NextRequest) {
  try {
    const body: StartSessionRequest = await request.json()
    const { userAddress, tokenAddress, amountUsd, intervalSeconds } = body

    // IMPORTANT: userAddress is the Smart Wallet address from Privy (NOT Embedded Wallet)
    // This is used as the unique identifier (user_address) in all database tables
    // We do NOT use Supabase Auth - only wallet address-based identification

    if (!userAddress || !tokenAddress || !amountUsd || !intervalSeconds) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, tokenAddress, amountUsd, intervalSeconds" },
        { status: 400 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()

    // Validate amountUsd with minimum 0.01 USD for micro transactions
    const amountUsdValue = parseFloat(amountUsd)
    const MIN_AMOUNT_USD = 0.01
    
    if (isNaN(amountUsdValue) || amountUsdValue <= 0) {
      return NextResponse.json(
        { error: "amountUsd must be a positive number" },
        { status: 400 }
      )
    }
    
    if (amountUsdValue < MIN_AMOUNT_USD) {
      return NextResponse.json(
        { error: `Minimum amount per bump is $${MIN_AMOUNT_USD.toFixed(2)} USD. Current: $${amountUsdValue.toFixed(2)} USD` },
        { status: 400 }
      )
    }

    // Validate intervalSeconds (2-600 seconds)
    if (intervalSeconds < 2 || intervalSeconds > 600) {
      return NextResponse.json(
        { error: "intervalSeconds must be between 2 and 600 seconds (2 seconds to 10 minutes)" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Check if user already has an active session
    // Database query uses user_address column (NOT user_id)
    const { data: activeSession, error: checkError } = await supabase
      .from("bot_sessions")
      .select("id, status")
      .eq("user_address", normalizedUserAddress)
      .eq("status", "running")
      .single()

    if (activeSession && !checkError) {
      return NextResponse.json(
        { error: "User already has an active bot session. Please stop the current session first." },
        { status: 409 }
      )
    }

    // Validate credit balance
    // Database query uses user_address column (NOT user_id)
    const { data: creditData, error: creditError } = await supabase
      .from("user_credits")
      .select("balance_wei")
      .eq("user_address", normalizedUserAddress)
      .single()

    if (creditError && creditError.code !== "PGRST116") {
      console.error("❌ Error fetching credit balance:", creditError)
      return NextResponse.json(
        { error: "Failed to fetch credit balance" },
        { status: 500 }
      )
    }

    // Get real-time ETH price for USD to ETH conversion
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

    // Convert USD to ETH (using current market price)
    // PENTING: Gunakan pembulatan angka yang aman (6-18 desimal di belakang koma untuk ETH)
    // Presisi tinggi untuk transaksi mikro 0.01 USD
    const amountEth = amountUsdValue / ethPriceUsd
    // Use Math.floor for safe rounding to avoid precision errors (18 decimals)
    const amountWei = BigInt(Math.floor(amountEth * 1e18))
    
    // Validate credit balance using USD (at least enough for one bump)
    const creditBalanceWei = creditData?.balance_wei
      ? BigInt(creditData.balance_wei.toString())
      : BigInt(0)
    const creditEth = Number(creditBalanceWei) / 1e18
    const creditUsd = creditEth * ethPriceUsd

    if (creditUsd < amountUsdValue) {
      return NextResponse.json(
        {
          error: "Insufficient credit balance",
          creditBalanceUsd: creditUsd.toFixed(2),
          requiredAmountUsd: amountUsdValue.toFixed(2),
          creditBalanceEth: creditEth.toFixed(6),
          requiredAmountEth: amountEth.toFixed(6),
        },
        { status: 400 }
      )
    }

    // Create new session
    // IMPORTANT: Using user_address column (NOT user_id) - this is the Smart Wallet address
    // Store amount_usd and interval_seconds in database
    // buy_amount_per_bump_wei will be calculated dynamically on each swap using real-time ETH price
    // Bot runs continuously until user stops it manually - no total_sessions limit
    const { data: sessionData, error: insertError } = await supabase
      .from("bot_sessions")
      .insert({
        user_address: normalizedUserAddress,
        token_address: tokenAddress,
        amount_usd: amountUsdValue.toString(), // Store USD amount for reference
        buy_amount_per_bump_wei: amountWei.toString(), // Store initial wei amount (will be recalculated on execution)
        interval_seconds: intervalSeconds,
        total_sessions: 0, // 0 = unlimited (runs continuously until stopped)
        current_session: 0,
        wallet_rotation_index: 0,
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (insertError) {
      console.error("❌ Error creating bot session:", insertError)
      return NextResponse.json(
        { error: "Failed to create bot session" },
        { status: 500 }
      )
    }

    console.log(`✅ Bot session started for user: ${userAddress}`)
    console.log(`   Token: ${tokenAddress}`)
    console.log(`   Mode: Continuous (runs until stopped)`)
    console.log(`   Amount per bump: $${amountUsdValue} USD (${amountEth.toFixed(6)} ETH / ${amountWei.toString()} wei)`)
    console.log(`   Interval: ${intervalSeconds} seconds`)

    return NextResponse.json({
      success: true,
      session: sessionData,
    })
  } catch (error: any) {
    console.error("❌ Error in POST /api/bot/session:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/bot/session - Stop active bot session
 * 
 * Updates bot session status to "stopped" and sets stopped_at timestamp.
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const userAddress = searchParams.get("userAddress")

    // IMPORTANT: userAddress is the Smart Wallet address from Privy (NOT Embedded Wallet)
    // This is used as the unique identifier (user_address) in all database tables

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required parameter: userAddress" },
        { status: 400 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()
    const supabase = createSupabaseServiceClient()

    // Find active session
    // Database query uses user_address column (NOT user_id)
    const { data: activeSession, error: findError } = await supabase
      .from("bot_sessions")
      .select("id, status")
      .eq("user_address", normalizedUserAddress)
      .eq("status", "running")
      .single()

    if (findError || !activeSession) {
      return NextResponse.json(
        { error: "No active bot session found" },
        { status: 404 }
      )
    }

    // Update session status to stopped
    const { data: updatedSession, error: updateError } = await supabase
      .from("bot_sessions")
      .update({
        status: "stopped",
        stopped_at: new Date().toISOString(),
      })
      .eq("id", activeSession.id)
      .select()
      .single()

    if (updateError) {
      console.error("❌ Error stopping bot session:", updateError)
      return NextResponse.json(
        { error: "Failed to stop bot session" },
        { status: 500 }
      )
    }

    console.log(`✅ Bot session stopped for user: ${userAddress}`)

    return NextResponse.json({
      success: true,
      session: updatedSession,
    })
  } catch (error: any) {
    console.error("❌ Error in DELETE /api/bot/session:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/bot/session - Get current bot session status
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const userAddress = searchParams.get("userAddress")

    // IMPORTANT: userAddress is the Smart Wallet address from Privy (NOT Embedded Wallet)
    // This is used as the unique identifier (user_address) in all database tables

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required parameter: userAddress" },
        { status: 400 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()
    const supabase = createSupabaseServiceClient()

    // Get active session
    // Database query uses user_address column (NOT user_id)
    const { data: session, error: fetchError } = await supabase
      .from("bot_sessions")
      .select("*")
      .eq("user_address", normalizedUserAddress)
      .eq("status", "running")
      .single()

    if (fetchError && fetchError.code !== "PGRST116") {
      console.error("❌ Error fetching bot session:", fetchError)
      return NextResponse.json(
        { error: "Failed to fetch bot session" },
        { status: 500 }
      )
    }

    if (!session) {
      return NextResponse.json({
        success: true,
        session: null,
        message: "No active session",
      })
    }

    return NextResponse.json({
      success: true,
      session,
    })
  } catch (error: any) {
    console.error("❌ Error in GET /api/bot/session:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
