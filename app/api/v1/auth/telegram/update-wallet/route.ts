import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { verifyTelegramInitData, extractTelegramId } from "@/lib/telegram-initdata-verify"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/v1/auth/telegram/update-wallet
 * 
 * Update wallet address for Telegram user after Privy creates wallet
 * 
 * This endpoint is called from frontend after Privy creates Smart Wallet.
 * It updates the wallet_address in telegram_user_mappings table.
 * 
 * Authentication:
 * - Uses Telegram initData verification (HMAC-SHA256)
 * - Validates initData using TELEGRAM_BOT_TOKEN
 * 
 * Request Body:
 * {
 *   "initData": "raw_initData_string",
 *   "wallet_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
 *   "privy_user_id": "did:privy:abc123"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "message": "Wallet address updated successfully",
 *   "data": { ... }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { initData, wallet_address, privy_user_id } = body

    // =============================================
    // 1. Validate Request Body
    // =============================================
    if (!initData) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required field: initData",
          message: "initData is required to verify Telegram user",
        },
        { status: 400 }
      )
    }

    if (!wallet_address) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required field: wallet_address",
          message: "wallet_address is required to update user mapping",
        },
        { status: 400 }
      )
    }

    if (!privy_user_id) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required field: privy_user_id",
          message: "privy_user_id is required to update user mapping",
        },
        { status: 400 }
      )
    }

    // Validate wallet address format
    const normalizedWalletAddress = wallet_address.toLowerCase()
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalizedWalletAddress)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid wallet_address format",
          message: "wallet_address must be a valid Ethereum address",
        },
        { status: 400 }
      )
    }

    // =============================================
    // 2. Verify Telegram initData
    // =============================================
    const botToken = process.env.TELEGRAM_BOT_TOKEN

    if (!botToken) {
      console.error("❌ TELEGRAM_BOT_TOKEN not configured in environment variables")
      return NextResponse.json(
        {
          success: false,
          error: "Server configuration error",
          message: "Telegram bot token is not configured",
        },
        { status: 500 }
      )
    }

    // Verify initData using HMAC-SHA256
    const verification = verifyTelegramInitData(initData, botToken)

    if (!verification.isValid) {
      console.warn("⚠️ Invalid initData:", verification.error)
      return NextResponse.json(
        {
          success: false,
          error: "Invalid initData",
          message: verification.error || "initData verification failed",
        },
        { status: 401 }
      )
    }

    // =============================================
    // 3. Extract Telegram ID
    // =============================================
    if (!verification.data) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid initData",
          message: "Failed to parse initData",
        },
        { status: 400 }
      )
    }

    const telegramId = extractTelegramId(verification.data)

    if (!telegramId) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing telegram_id",
          message: "Could not extract telegram_id from initData",
        },
        { status: 400 }
      )
    }

    // =============================================
    // 4. Update Database
    // =============================================
    const supabase = createSupabaseServiceClient()

    // Check if user mapping exists
    const { data: existingData, error: checkError } = await supabase
      .from("telegram_user_mappings")
      .select("id, telegram_id")
      .eq("telegram_id", telegramId)
      .single()

    if (checkError && checkError.code !== "PGRST116") {
      console.error("❌ Error checking user mapping:", checkError)
      return NextResponse.json(
        {
          success: false,
          error: "Database error",
          message: checkError.message || "Failed to check user mapping",
        },
        { status: 500 }
      )
    }

    // Upsert user mapping
    const { data, error } = await supabase
      .from("telegram_user_mappings")
      .upsert(
        {
          telegram_id: telegramId,
          wallet_address: normalizedWalletAddress,
          privy_user_id: privy_user_id,
          is_active: true,
          last_login_at: new Date().toISOString(),
        },
        {
          onConflict: "telegram_id", // Update if telegram_id already exists
        }
      )
      .select()
      .single()

    if (error) {
      console.error("❌ Error updating user mapping:", error)
      return NextResponse.json(
        {
          success: false,
          error: "Database error",
          message: error.message || "Failed to update user mapping",
        },
        { status: 500 }
      )
    }

    console.log("✅ Wallet address updated:", {
      telegram_id: telegramId,
      wallet_address: normalizedWalletAddress,
      privy_user_id: privy_user_id,
    })

    return NextResponse.json({
      success: true,
      message: "Wallet address updated successfully",
      data: {
        telegram_id: telegramId,
        wallet_address: normalizedWalletAddress,
        privy_user_id: privy_user_id,
        last_login_at: data.last_login_at,
      },
    })
  } catch (error: any) {
    console.error("❌ Error in update wallet endpoint:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        message: error.message || "Failed to update wallet address",
      },
      { status: 500 }
    )
  }
}

