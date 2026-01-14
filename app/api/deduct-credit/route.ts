import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { formatEther } from "viem"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Endpoint: Deduct Credit from Main Wallet (user_credits table)
 * 
 * Reduces balance_wei in user_credits when credit is distributed to bot wallets.
 * This ensures main wallet credit balance is accurate after distribution.
 * 
 * IMPORTANT: This is called after distribute-credits completes successfully.
 * If this fails, distribution still succeeded, but credit balance may be incorrect.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress, amountWei } = body as {
      userAddress: string
      amountWei: string
    }

    if (!userAddress || !amountWei) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, amountWei" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()
    const normalizedUserAddress = userAddress.toLowerCase()
    const amountToDeduct = BigInt(amountWei)

    // Get current balance from user_credits
    const { data: creditData, error: fetchError } = await supabase
      .from("user_credits")
      .select("balance_wei")
      .eq("user_address", normalizedUserAddress)
      .single()

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        // No record found - nothing to deduct
        console.warn(`⚠️ No credit record found for user ${normalizedUserAddress}`)
        return NextResponse.json({
          success: true,
          message: "No credit record found - nothing to deduct",
          deductedAmountWei: "0",
          remainingBalanceWei: "0",
        })
      }

      console.error("❌ Error fetching user credits:", fetchError)
      return NextResponse.json(
        { error: "Failed to fetch user credits", details: fetchError.message },
        { status: 500 }
      )
    }

    if (!creditData) {
      return NextResponse.json({
        success: true,
        message: "No credit record found - nothing to deduct",
        deductedAmountWei: "0",
        remainingBalanceWei: "0",
      })
    }

    // Calculate new balance
    const currentBalance = BigInt(creditData.balance_wei || "0")
    const newBalance = currentBalance >= amountToDeduct ? currentBalance - amountToDeduct : BigInt(0)

    // Update balance_wei in user_credits
    const { error: updateError } = await supabase
      .from("user_credits")
      .update({
        balance_wei: newBalance.toString(),
        last_updated: new Date().toISOString(),
      })
      .eq("user_address", normalizedUserAddress)

    if (updateError) {
      console.error("❌ Error updating user credits:", updateError)
      return NextResponse.json(
        { error: "Failed to update user credits", details: updateError.message },
        { status: 500 }
      )
    }

    console.log(`✅ Credit deducted from main wallet (user_credits):`)
    console.log(`   User: ${normalizedUserAddress}`)
    console.log(`   Previous Balance: ${formatEther(currentBalance)} ETH`)
    console.log(`   Deducted: ${formatEther(amountToDeduct)} ETH`)
    console.log(`   New Balance: ${formatEther(newBalance)} ETH`)

    return NextResponse.json({
      success: true,
      message: "Credit deducted successfully",
      deductedAmountWei: amountToDeduct.toString(),
      remainingBalanceWei: newBalance.toString(),
    })
  } catch (error: any) {
    console.error("❌ Error in deduct-credit API:", error)
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

