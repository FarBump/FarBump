import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes max execution time

interface ContinuousSwapRequest {
  userAddress: string
}

/**
 * API Route: Continuous Swap Execution (Server-Side Loop)
 * 
 * This route implements a perpetual round-robin swap loop that:
 * 1. Fetches the active bot session and wallet_rotation_index
 * 2. Executes a swap for the current bot wallet
 * 3. Checks if wallet balance is sufficient (>= $0.01 USD)
 * 4. Rotates to next wallet (round-robin: 0 → 1 → 2 → 3 → 4 → 0)
 * 5. Continues until all wallets have balance < $0.01 USD
 * 6. Logs all activities to bot_logs for Live Activity feed
 * 
 * This is called ONCE after funding completes, and it runs continuously
 * until the session is stopped or all wallets are depleted.
 */
export async function POST(request: NextRequest) {
  try {
    const body: ContinuousSwapRequest = await request.json()
    const { userAddress } = body

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required field: userAddress" },
        { status: 400 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()
    const supabase = createSupabaseServiceClient()

    // Fetch active session
    const { data: session, error: sessionError } = await supabase
      .from("bot_sessions")
      .select("id, status, interval_seconds, wallet_rotation_index")
      .eq("user_address", normalizedUserAddress)
      .eq("status", "running")
      .single()

    if (sessionError || !session) {
      return NextResponse.json(
        { error: "No active bot session found" },
        { status: 404 }
      )
    }

    console.log(`🔄 Starting continuous swap loop for user: ${normalizedUserAddress}`)
    console.log(`   Session ID: ${session.id}`)
    console.log(`   Interval: ${session.interval_seconds}s`)
    console.log(`   Starting wallet index: ${session.wallet_rotation_index}`)

    // Start continuous loop
    let currentRotationIndex = session.wallet_rotation_index || 0
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5 // Stop after 5 consecutive failures

    while (true) {
      // Check if session is still running
      const { data: currentSession } = await supabase
        .from("bot_sessions")
        .select("status")
        .eq("id", session.id)
        .single()

      if (!currentSession || currentSession.status !== "running") {
        console.log("⏹️ Session stopped by user")
        break
      }

      // Execute swap for current wallet
      console.log(`\n🔄 Round-robin swap - Wallet #${currentRotationIndex + 1}`)
      
      try {
        const swapResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/bot/execute-swap`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userAddress: normalizedUserAddress,
            walletIndex: currentRotationIndex,
          }),
        })

        const swapResult = await swapResponse.json()

        if (swapResponse.ok) {
          console.log(`✅ Swap successful for Wallet #${currentRotationIndex + 1}`)
          consecutiveFailures = 0

          // Check if session was stopped due to all wallets being empty
          if (swapResult.stopped) {
            console.log("🛑 All wallets depleted. Stopping continuous loop.")
            break
          }

          // Rotate to next wallet (round-robin)
          currentRotationIndex = (currentRotationIndex + 1) % 5
        } else {
          // Handle errors
          if (swapResult.stopped) {
            console.log("🛑 All wallets depleted. Stopping continuous loop.")
            break
          }

          if (swapResult.skipped) {
            console.log(`⏭️ Wallet #${currentRotationIndex + 1} skipped (insufficient balance)`)
            // Rotate to next wallet
            currentRotationIndex = (currentRotationIndex + 1) % 5
            consecutiveFailures = 0
          } else {
            console.error(`❌ Swap failed for Wallet #${currentRotationIndex + 1}:`, swapResult.error)
            consecutiveFailures++

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.error("🛑 Too many consecutive failures. Stopping continuous loop.")
              
              // Log system error
              await supabase.from("bot_logs").insert({
                user_address: normalizedUserAddress,
                wallet_address: null,
                token_address: null,
                amount_wei: "0",
                status: "failed",
                message: `[System] Continuous swap loop stopped due to ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
              })

              // Stop session
              await supabase
                .from("bot_sessions")
                .update({
                  status: "stopped",
                  stopped_at: new Date().toISOString(),
                })
                .eq("id", session.id)

              break
            }

            // Rotate to next wallet even on failure
            currentRotationIndex = (currentRotationIndex + 1) % 5
          }
        }
      } catch (error: any) {
        console.error(`❌ Error executing swap for Wallet #${currentRotationIndex + 1}:`, error)
        consecutiveFailures++

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error("🛑 Too many consecutive failures. Stopping continuous loop.")
          
          // Log system error
          await supabase.from("bot_logs").insert({
            user_address: normalizedUserAddress,
            wallet_address: null,
            token_address: null,
            amount_wei: "0",
            status: "failed",
            message: `[System] Continuous swap loop stopped due to ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
          })

          // Stop session
          await supabase
            .from("bot_sessions")
            .update({
              status: "stopped",
              stopped_at: new Date().toISOString(),
            })
            .eq("id", session.id)

          break
        }

        // Rotate to next wallet even on error
        currentRotationIndex = (currentRotationIndex + 1) % 5
      }

      // Wait for interval before next swap
      console.log(`⏱️ Waiting ${session.interval_seconds}s before next swap...`)
      await new Promise(resolve => setTimeout(resolve, session.interval_seconds * 1000))
    }

    console.log("✅ Continuous swap loop completed")

    return NextResponse.json({
      success: true,
      message: "Continuous swap loop completed",
    })
  } catch (error: any) {
    console.error("❌ Error in continuous swap loop:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}


