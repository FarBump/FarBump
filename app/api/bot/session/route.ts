import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { type Address } from "viem"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface StartSessionRequest {
  userAddress: string
  tokenAddress: Address
  buyAmountPerBumpWei: string
  totalBumps: number
  intervalMinutes?: number // Optional: interval between bumps (default: 1 minute)
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
    const { userAddress, tokenAddress, buyAmountPerBumpWei, totalBumps, intervalMinutes = 1 } = body

    if (!userAddress || !tokenAddress || !buyAmountPerBumpWei || !totalBumps) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, tokenAddress, buyAmountPerBumpWei, totalBumps" },
        { status: 400 }
      )
    }

    if (totalBumps <= 0) {
      return NextResponse.json(
        { error: "totalBumps must be greater than 0" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Check if user already has an active session
    const { data: activeSession, error: checkError } = await supabase
      .from("bot_sessions")
      .select("id, status")
      .eq("user_address", userAddress.toLowerCase())
      .eq("status", "running")
      .single()

    if (activeSession && !checkError) {
      return NextResponse.json(
        { error: "User already has an active bot session. Please stop the current session first." },
        { status: 409 }
      )
    }

    // Validate credit balance
    const { data: creditData, error: creditError } = await supabase
      .from("user_credits")
      .select("balance_wei")
      .eq("user_address", userAddress.toLowerCase())
      .single()

    if (creditError && creditError.code !== "PGRST116") {
      console.error("❌ Error fetching credit balance:", creditError)
      return NextResponse.json(
        { error: "Failed to fetch credit balance" },
        { status: 500 }
      )
    }

    const creditBalanceWei = creditData?.balance_wei
      ? BigInt(creditData.balance_wei.toString())
      : BigInt(0)
    const requiredAmountWei = BigInt(buyAmountPerBumpWei) * BigInt(totalBumps)

    if (creditBalanceWei < requiredAmountWei) {
      const creditEth = Number(creditBalanceWei) / 1e18
      const requiredEth = Number(requiredAmountWei) / 1e18
      return NextResponse.json(
        {
          error: "Insufficient credit balance",
          creditBalance: creditBalanceWei.toString(),
          requiredAmount: requiredAmountWei.toString(),
          creditBalanceEth: creditEth.toFixed(6),
          requiredAmountEth: requiredEth.toFixed(6),
        },
        { status: 400 }
      )
    }

    // Create new session
    const { data: sessionData, error: insertError } = await supabase
      .from("bot_sessions")
      .insert({
        user_address: userAddress.toLowerCase(),
        token_address: tokenAddress,
        buy_amount_per_bump_wei: buyAmountPerBumpWei,
        total_sessions: totalBumps,
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
    console.log(`   Total bumps: ${totalBumps}`)
    console.log(`   Amount per bump: ${buyAmountPerBumpWei} wei`)

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

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required parameter: userAddress" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Find active session
    const { data: activeSession, error: findError } = await supabase
      .from("bot_sessions")
      .select("id, status")
      .eq("user_address", userAddress.toLowerCase())
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

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required parameter: userAddress" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Get active session
    const { data: session, error: fetchError } = await supabase
      .from("bot_sessions")
      .select("*")
      .eq("user_address", userAddress.toLowerCase())
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
