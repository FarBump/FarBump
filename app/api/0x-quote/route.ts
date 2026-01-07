import { NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// 0x API v2 Configuration
const ZEROX_API_BASE_URL = "https://base.api.0x.org"
const ZEROX_API_KEY = process.env.NEXT_PUBLIC_ZEROX_API_KEY || process.env.ZEROX_API_KEY || ""

/**
 * Proxy endpoint for 0x Swap API v2 quote
 * This avoids CORS issues by making the request from server-side
 * 
 * Query parameters:
 * - sellToken: Token address to sell
 * - buyToken: Token address to buy
 * - sellAmount: Amount to sell (in wei)
 * - takerAddress: Address that will receive the tokens
 * - slippagePercentage: Slippage tolerance (default: 0.5)
 */
export async function GET(request: NextRequest) {
  try {
    // Check API key
    if (!ZEROX_API_KEY) {
      return NextResponse.json(
        { error: "0x API key not configured" },
        { status: 500 }
      )
    }

    // Get query parameters
    const searchParams = request.nextUrl.searchParams
    const sellToken = searchParams.get("sellToken")
    const buyToken = searchParams.get("buyToken")
    const sellAmount = searchParams.get("sellAmount")
    const takerAddress = searchParams.get("takerAddress")
    const slippagePercentage = searchParams.get("slippagePercentage") || "0.5"

    // Validate required parameters
    if (!sellToken || !buyToken || !sellAmount || !takerAddress) {
      return NextResponse.json(
        { error: "Missing required parameters: sellToken, buyToken, sellAmount, takerAddress" },
        { status: 400 }
      )
    }

    // Build query parameters for 0x API
    const queryParams = new URLSearchParams({
      sellToken,
      buyToken,
      sellAmount,
      takerAddress,
      slippagePercentage,
      enablePermit2: "true",
    })

    const url = `${ZEROX_API_BASE_URL}/swap/v2/quote?${queryParams.toString()}`
    
    console.log("📊 Proxying 0x Swap API v2 quote request...")
    console.log(`  URL: ${url}`)
    console.log(`  Sell Token: ${sellToken}`)
    console.log(`  Buy Token: ${buyToken}`)
    console.log(`  Sell Amount: ${sellAmount}`)
    console.log(`  Slippage: ${slippagePercentage}%`)

    // Make request to 0x API from server-side (no CORS issues)
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "0x-api-key": ZEROX_API_KEY,
        "Accept": "application/json",
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorData: any = { message: "Unknown error" }
      
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { message: errorText || response.statusText }
      }
      
      console.error("❌ 0x API error:", {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
      })
      
      // Handle v2 API issues array
      if (errorData.issues && Array.isArray(errorData.issues)) {
        const errorMessages = errorData.issues
          .filter((issue: any) => issue.severity === "error")
          .map((issue: any) => issue.reason)
          .join(", ")
        return NextResponse.json(
          { error: `0x API v2 error: ${errorMessages || errorData.reason || errorData.message || response.statusText}` },
          { status: response.status }
        )
      }
      
      // Handle "no Route matched" error - this means no liquidity available
      if (errorData.reason?.includes("no Route matched") || errorData.message?.includes("no Route matched")) {
        return NextResponse.json(
          { error: "No liquidity route found for this token pair. The swap amount may be too large or liquidity is insufficient." },
          { status: 400 }
        )
      }
      
      return NextResponse.json(
        { error: `0x API v2 error: ${errorData.reason || errorData.message || response.statusText}` },
        { status: response.status }
      )
    }

    const quoteData = await response.json()
    
    // Check for issues in v2 response
    if (quoteData.issues && quoteData.issues.length > 0) {
      const errors = quoteData.issues.filter((issue: any) => issue.severity === "error")
      if (errors.length > 0) {
        const errorMessages = errors.map((issue: any) => issue.reason).join(", ")
        return NextResponse.json(
          { error: `0x API v2 issues detected: ${errorMessages}` },
          { status: 400 }
        )
      }
      
      // Log warnings if any
      const warnings = quoteData.issues.filter((issue: any) => issue.severity === "warning")
      if (warnings.length > 0) {
        console.warn("⚠️ 0x API v2 warnings:", warnings.map((w: any) => w.reason).join(", "))
      }
    }
    
    console.log("✅ 0x API v2 Quote received:")
    console.log(`  - Price: ${quoteData.price}`)
    console.log(`  - Buy Amount: ${quoteData.buyAmount}`)
    console.log(`  - Sell Amount: ${quoteData.sellAmount}`)
    console.log(`  - Estimated Price Impact: ${quoteData.estimatedPriceImpact}%`)

    // Return quote data
    return NextResponse.json(quoteData)
  } catch (error: any) {
    console.error("❌ Error proxying 0x API request:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

