import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { verifyTelegramInitData, extractTelegramId, extractUserData } from "@/lib/telegram-initdata-verify"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/v1/auth/telegram/verify
 * 
 * Verify Telegram Mini App initData and return user data
 * 
 * This endpoint is used by Telegram Mini App to verify initData and get user data.
 * 
 * Authentication:
 * - Uses Telegram initData verification (HMAC-SHA256)
 * - Validates initData using TELEGRAM_BOT_TOKEN
 * - Only returns data if telegram_id exists in database (user has logged in)
 * 
 * Security:
 * - User login auth already secure via Privy
 * - Only verified Telegram IDs (from database) can get data
 * - initData validation prevents tampering
 * 
 * Query Parameters:
 * - initData (required): Raw initData string from window.Telegram.WebApp.initData
 * 
 * Response (if user is logged in):
 * {
 *   "success": true,
 *   "is_valid": true,
 *   "telegram_id": "123456789",
 *   "smart_account_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
 *   "privy_user_id": "did:privy:abc123",
 *   "telegram_username": "john_doe",
 *   "last_login_at": "2024-01-01T00:00:00Z"
 * }
 * 
 * Response (if user is not logged in):
 * {
 *   "success": true,
 *   "is_valid": false,
 *   "telegram_id": "123456789",
 *   "message": "User has not logged in to FarBump via Privy"
 * }
 * 
 * Error Responses:
 * - 400: Missing or invalid initData
 * - 401: Invalid initData hash (tampered)
 * - 500: Internal server error
 */
export async function GET(request: NextRequest) {
  try {
    // =============================================
    // 1. Get initData from Query Parameters
    // =============================================
    const { searchParams } = new URL(request.url)
    const initData = searchParams.get("initData")

    if (!initData) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required parameter: initData",
          message: "initData is required as query parameter. Get it from window.Telegram.WebApp.initData",
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
          message: verification.error || "initData verification failed. Data may be tampered with.",
        },
        { status: 401 }
      )
    }

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

    // =============================================
    // 3. Extract Telegram ID and User Data
    // =============================================
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

    // Extract additional user data
    const userData = extractUserData(verification.data)

    // =============================================
    // 4. Query Database for User Data
    // =============================================
    const supabase = createSupabaseServiceClient()

    const { data: dbData, error } = await supabase
      .from("telegram_user_mappings")
      .select("wallet_address, privy_user_id, telegram_username, last_login_at, is_active")
      .eq("telegram_id", telegramId)
      .eq("is_active", true)
      .single()

    if (error) {
      // If no record found, user hasn't logged in via Privy yet
      if (error.code === "PGRST116") {
        return NextResponse.json({
          success: true,
          is_valid: false,
          telegram_id: telegramId,
          telegram_username: userData.username,
          first_name: userData.first_name,
          last_name: userData.last_name,
          photo_url: userData.photo_url,
          message: "User has not logged in to FarBump via Privy. Please login first.",
        })
      }

      console.error("❌ Error querying Telegram user mapping:", error)
      return NextResponse.json(
        {
          success: false,
          error: "Database error",
          message: error.message || "Failed to query user data",
        },
        { status: 500 }
      )
    }

    if (!dbData) {
      return NextResponse.json({
        success: true,
        is_valid: false,
        telegram_id: telegramId,
        telegram_username: userData.username,
        message: "User has not logged in to FarBump via Privy. Please login first.",
      })
    }

    // =============================================
    // 5. Return Success Response
    // =============================================
    console.log("✅ Telegram user verified:", {
      telegram_id: telegramId,
      wallet_address: dbData.wallet_address,
      privy_user_id: dbData.privy_user_id,
    })

    return NextResponse.json({
      success: true,
      is_valid: true,
      telegram_id: telegramId,
      smart_account_address: dbData.wallet_address,
      privy_user_id: dbData.privy_user_id,
      telegram_username: dbData.telegram_username || userData.username || null,
      last_login_at: dbData.last_login_at,
    })
  } catch (error: any) {
    console.error("❌ Error in Telegram verify endpoint:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        message: error.message || "Failed to verify Telegram user",
      },
      { status: 500 }
    )
  }
}
