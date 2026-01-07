import { NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// 0x API v2 Configuration (per 0x Protocol documentation)
// IMPORTANT: API key is server-side only for security
// Use ZEROX_API_KEY (not NEXT_PUBLIC_ZEROX_API_KEY) to prevent exposure to client
// For Swap API v2, use unified endpoint with chainId parameter
const ZEROX_API_BASE_URLS = [
  "https://api.0x.org", // Unified endpoint for all chains (Swap API v2)
]
const ZEROX_API_KEY = process.env.ZEROX_API_KEY || ""

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
    // Log request for debugging
    console.log("[0x-quote] GET request received:", request.nextUrl.pathname)
    
    // Check API key
    if (!ZEROX_API_KEY) {
      console.error("[0x-quote] ZEROX_API_KEY not configured")
      return NextResponse.json(
        { error: "0x API key not configured" },
        { status: 500 }
      )
    }
    
    console.log("[0x-quote] API key found, processing request...")

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

    // Build query parameters for 0x Swap API v2
    // Based on 0x Protocol documentation: https://0x.org/docs/upgrading/upgrading_to_swap_v2
    // IMPORTANT: Swap API v2 uses unified endpoint with chainId parameter
    // We don't restrict liquidity sources to allow Uniswap V4 to be accessible
    const queryParams = new URLSearchParams({
      chainId: "8453", // Base network chain ID
      sellToken,
      buyToken,
      sellAmount,
      takerAddress,
      slippagePercentage,
      enablePermit2: "true", // Required: Enable Permit2 for efficient approvals
      includePriceImpact: "true", // Include price impact in response
    })
    
    // Note: We don't add 'excludedSources' or 'includedSources' to allow all liquidity sources
    // This ensures Uniswap V4 pools are accessible

    // Use unified 0x Swap API v2 endpoint
    // Based on 0x documentation: https://0x.org/docs/upgrading/upgrading_to_swap_v2
    const baseUrl = ZEROX_API_BASE_URLS[0] // Use unified endpoint
    const apiUrl = `${baseUrl}/swap/v1/quote?${queryParams.toString()}`
    console.log(`📊 Proxying 0x Swap API v2 quote request to ${baseUrl}...`)
    console.log(`  URL: ${apiUrl}`)
    console.log(`  Sell Token: ${sellToken}`)
    console.log(`  Buy Token: ${buyToken}`)
    console.log(`  Sell Amount: ${sellAmount}`)
    console.log(`  Slippage: ${slippagePercentage}%`)

    // Make request with proper headers for v2 API
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "0x-api-key": ZEROX_API_KEY,
        "0x-version": "v2", // Required header for v2 API
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

      console.error(`❌ 0x API error from ${baseUrl}:`, {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
      })

      return NextResponse.json(
        { error: `0x API v2 error: ${errorData.message || errorData.reason || response.statusText}` },
        { status: response.status }
      )
    }

    // Success - parse and return quote data
    const quoteData = await response.json()
    console.log(`[0x-quote] 0x API v2 quote received successfully`)

    // Check for issues in v2 response
    if (quoteData.issues && Array.isArray(quoteData.issues)) {
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
        console.warn("⚠️ 0x API v2 warnings:", warnings.map((issue: any) => issue.reason))
      }
    }

    console.log("✅ 0x Swap API v2 Quote received:")
    console.log(`  - Chain ID: ${quoteData.chainId}`)
    console.log(`  - Price: ${quoteData.price}`)
    console.log(`  - Buy Amount: ${quoteData.buyAmount}`)
    console.log(`  - Sell Amount: ${quoteData.sellAmount}`)
    console.log(`  - Estimated Price Impact: ${quoteData.estimatedPriceImpact}%`)
    console.log(`  - Fees:`, quoteData.fees)

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
