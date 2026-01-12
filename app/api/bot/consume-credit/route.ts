import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { formatEther } from "viem"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Endpoint: Consume Credit from Bot Wallet
 * 
 * Reduces credit balance when bot wallet consumes credit during swap execution.
 * 
 * Logic:
 * 1. Find the bot_wallet_credits record for this bot wallet
 * 2. Reduce the distributed_amount_wei by the consumed amount
 * 3. If distributed_amount_wei becomes 0 or negative, set it to 0
 * 
 * This ensures:
 * - Total credit balance = Main wallet credit + Sum of remaining bot wallet credits
 * - Credit balance decreases in real-time as bot consumes credit
 * - Only valid credits from Distribute function are tracked
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress, botWalletAddress, consumedAmountWei } = body as {
      userAddress: string
      botWalletAddress: string
      consumedAmountWei: string
    }

    if (!userAddress || !botWalletAddress || !consumedAmountWei) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, botWalletAddress, consumedAmountWei" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()
    const normalizedUserAddress = userAddress.toLowerCase()
    const normalizedBotWalletAddress = botWalletAddress.toLowerCase()

    // Find all bot_wallet_credits records for this bot wallet
    // Note: A bot wallet may have received multiple distributions
    const { data: creditRecords, error: fetchError } = await supabase
      .from("bot_wallet_credits")
      .select("id, distributed_amount_wei")
      .eq("user_address", normalizedUserAddress)
      .eq("bot_wallet_address", normalizedBotWalletAddress)
      .order("created_at", { ascending: false }) // Most recent first

    if (fetchError) {
      console.error("❌ Error fetching bot wallet credits:", fetchError)
      return NextResponse.json(
        { error: "Failed to fetch bot wallet credits", details: fetchError.message },
        { status: 500 }
      )
    }

    if (!creditRecords || creditRecords.length === 0) {
      console.warn(`⚠️ No credit records found for bot wallet ${normalizedBotWalletAddress}`)
      // This is OK - bot wallet may not have received credit yet
      return NextResponse.json({
        success: true,
        message: "No credit records found for this bot wallet",
        consumedAmountWei: "0",
        remainingCreditWei: "0",
      })
    }

    // Calculate total credit for this bot wallet
    const totalCreditWei = creditRecords.reduce((sum, record) => {
      return sum + BigInt(record.distributed_amount_wei || "0")
    }, BigInt(0))

    const consumedAmount = BigInt(consumedAmountWei)

    // Check if there's enough credit to consume
    if (totalCreditWei < consumedAmount) {
      console.warn(
        `⚠️ Insufficient credit: Total ${formatEther(totalCreditWei)} ETH, Consumed ${formatEther(consumedAmount)} ETH`
      )
      // Consume all available credit
      const remainingCredit = BigInt(0)
      
      // Update all records to 0
      for (const record of creditRecords) {
        await supabase
          .from("bot_wallet_credits")
          .update({ distributed_amount_wei: "0" })
          .eq("id", record.id)
      }

      return NextResponse.json({
        success: true,
        message: "Consumed all available credit (insufficient balance)",
        consumedAmountWei: totalCreditWei.toString(),
        remainingCreditWei: "0",
      })
    }

    // Consume credit from most recent records first (FIFO - First In First Out)
    let remainingToConsume = consumedAmount
    const updatedRecords: Array<{ id: string; newAmount: string }> = []

    for (const record of creditRecords) {
      if (remainingToConsume <= BigInt(0)) break

      const recordAmount = BigInt(record.distributed_amount_wei || "0")
      
      if (recordAmount <= remainingToConsume) {
        // Consume entire record
        await supabase
          .from("bot_wallet_credits")
          .update({ distributed_amount_wei: "0" })
          .eq("id", record.id)
        
        updatedRecords.push({ id: record.id, newAmount: "0" })
        remainingToConsume -= recordAmount
      } else {
        // Consume partial amount
        const newAmount = recordAmount - remainingToConsume
        await supabase
          .from("bot_wallet_credits")
          .update({ distributed_amount_wei: newAmount.toString() })
          .eq("id", record.id)
        
        updatedRecords.push({ id: record.id, newAmount: newAmount.toString() })
        remainingToConsume = BigInt(0)
      }
    }

    const remainingCredit = totalCreditWei - consumedAmount

    console.log(`✅ Credit consumed:`)
    console.log(`   Bot Wallet: ${normalizedBotWalletAddress}`)
    console.log(`   Consumed: ${formatEther(consumedAmount)} ETH`)
    console.log(`   Remaining: ${formatEther(remainingCredit)} ETH`)
    console.log(`   Updated ${updatedRecords.length} record(s)`)

    return NextResponse.json({
      success: true,
      message: "Credit consumed successfully",
      consumedAmountWei: consumedAmount.toString(),
      remainingCreditWei: remainingCredit.toString(),
      updatedRecords: updatedRecords.length,
    })
  } catch (error: any) {
    console.error("❌ Error in consume-credit API:", error)
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

