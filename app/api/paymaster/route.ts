import { NextRequest, NextResponse } from "next/server"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

/**
 * Paymaster Proxy API Route
 * 
 * This endpoint acts as a proxy between the frontend and Coinbase CDP Paymaster.
 * It forwards JSON-RPC requests to the CDP Paymaster service and returns responses.
 * 
 * Security:
 * - Validates request structure (must be JSON-RPC format)
 * - Validates User Operation structure
 * - Only forwards to configured CDP_PAYMASTER_URL
 * 
 * Environment Variables Required:
 * - CDP_PAYMASTER_URL: Full URL to CDP Paymaster service
 *   Format: https://api.developer.coinbase.com/rpc/v1/base/{API_KEY}
 */
export async function POST(request: NextRequest) {
  try {
    // Get CDP Paymaster URL from environment
    const cdpPaymasterUrl = process.env.CDP_PAYMASTER_URL || process.env.NEXT_PUBLIC_CDP_PAYMASTER_URL

    if (!cdpPaymasterUrl) {
      console.error("❌ CDP_PAYMASTER_URL not configured in environment variables")
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: "Paymaster service not configured",
            data: "CDP_PAYMASTER_URL environment variable is missing",
          },
        },
        { status: 500 }
      )
    }

    // Parse request body
    let requestBody: any
    try {
      requestBody = await request.json()
    } catch (parseError) {
      console.error("❌ Invalid JSON in request body:", parseError)
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: requestBody?.id || null,
          error: {
            code: -32700,
            message: "Parse error",
            data: "Invalid JSON in request body",
          },
        },
        { status: 400 }
      )
    }

    // =============================================
    // Security Validation: JSON-RPC Structure
    // =============================================
    if (!requestBody || typeof requestBody !== "object") {
      console.error("❌ Invalid request body structure")
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: requestBody?.id || null,
          error: {
            code: -32600,
            message: "Invalid Request",
            data: "Request body must be a valid JSON-RPC object",
          },
        },
        { status: 400 }
      )
    }

    // Validate JSON-RPC version
    if (requestBody.jsonrpc !== "2.0") {
      console.warn("⚠️ Invalid JSON-RPC version:", requestBody.jsonrpc)
    }

    // =============================================
    // Security Validation: User Operation Structure
    // =============================================
    // Check if this is a paymaster-related method
    const method = requestBody.method
    const params = requestBody.params || []

    // Only allow specific paymaster methods
    const allowedMethods = [
      "pm_getPaymasterStubData",
      "pm_getPaymasterData",
      "pm_getPaymasterAndData",
    ]

    if (!allowedMethods.includes(method)) {
      console.warn(`⚠️ Unauthorized method: ${method}`)
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: requestBody.id || null,
          error: {
            code: -32601,
            message: "Method not found",
            data: `Method '${method}' is not allowed through this proxy`,
          },
        },
        { status: 400 }
      )
    }

    // Validate User Operation structure (first param should be an object)
    if (params.length > 0 && typeof params[0] === "object") {
      const userOp = params[0]

      // Basic validation: User Operation should have required fields
      const requiredFields = ["sender", "nonce", "callData"]
      const missingFields = requiredFields.filter((field) => !userOp[field])

      if (missingFields.length > 0) {
        console.error(`❌ Invalid User Operation: missing fields ${missingFields.join(", ")}`)
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: requestBody.id || null,
            error: {
              code: -32602,
              message: "Invalid params",
              data: `User Operation missing required fields: ${missingFields.join(", ")}`,
            },
          },
          { status: 400 }
        )
      }

      // Log User Operation details (without sensitive data)
      console.log(`\n📤 Paymaster Request:`)
      console.log(`   → Method: ${method}`)
      console.log(`   → Sender: ${userOp.sender?.substring(0, 10)}...`)
      console.log(`   → Nonce: ${userOp.nonce}`)
      console.log(`   → Call Data length: ${userOp.callData?.length || 0} chars`)
    } else {
      console.warn("⚠️ User Operation structure not found in params")
    }

    // =============================================
    // Forward Request to CDP Paymaster
    // =============================================
    console.log(`\n🔄 Forwarding to CDP Paymaster: ${cdpPaymasterUrl.replace(/\/rpc\/v1\/base\/[^/]+/, "/rpc/v1/base/***")}`)

    try {
      const paymasterResponse = await fetch(cdpPaymasterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      })

      // Get response body
      const responseData = await paymasterResponse.json()

      // Log response status
      if (paymasterResponse.ok && !responseData.error) {
        console.log(`✅ Paymaster response: SUCCESS`)
      } else {
        console.error(`❌ Paymaster response: ERROR`)
        console.error(`   → Error: ${JSON.stringify(responseData.error)}`)
      }

      // Return the response from CDP Paymaster
      return NextResponse.json(responseData, {
        status: paymasterResponse.status,
        headers: {
          "Content-Type": "application/json",
        },
      })
    } catch (fetchError: any) {
      console.error("❌ Error forwarding to CDP Paymaster:", fetchError.message)
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: requestBody.id || null,
          error: {
            code: -32603,
            message: "Internal error",
            data: `Failed to connect to Paymaster service: ${fetchError.message}`,
          },
        },
        { status: 500 }
      )
    }
  } catch (error: any) {
    console.error("❌ Unexpected error in Paymaster Proxy:", error)
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "Internal error",
          data: error.message || "Unexpected error occurred",
        },
      },
      { status: 500 }
    )
  }
}

