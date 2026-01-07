import { NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// 0x API v2 Configuration
// IMPORTANT: API key is server-side only for security
// Use ZEROX_API_KEY (not NEXT_PUBLIC_ZEROX_API_KEY) to prevent exposure to client
// Try base.api.0x.org first, fallback to api.0x.org if needed for V4 routes
const ZEROX_API_BASE_URLS = [
  "https://base.api.0x.org",
  "https://api.0x.org", // Fallback for better V4 route discovery
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

    // Build query parameters for 0x API
    // IMPORTANT: enablePermit2 is required for efficient token approvals
    // We don't restrict liquidity sources to allow Uniswap V4 to be accessible
    // includePriceImpact=true to get price impact estimates
    // intentOnFill=true: Indicates intent to fill the quote (required for Settler contract)
    // enableSlippageProtection=false: Disable slippage protection to allow higher slippage for large swaps
    const queryParams = new URLSearchParams({
      sellToken,
      buyToken,
      sellAmount,
      takerAddress,
      slippagePercentage,
      enablePermit2: "true", // Required: Enable Permit2 for efficient approvals
      includePriceImpact: "true", // Include price impact in response
      intentOnFill: "true", // Required: Indicates intent to fill the quote (for Settler contract)
      enableSlippageProtection: "false", // Disable slippage protection for large swaps
    })
    
    // Note: We don't add 'excludedSources' or 'includedSources' to allow all liquidity sources
    // This ensures Uniswap V4 pools are accessible

    // Try multiple API endpoints for better route discovery
    let lastError: any = null
    let quoteData: any = null
    
    for (const baseUrl of ZEROX_API_BASE_URLS) {
      const url = `${baseUrl}/swap/v2/quote?${queryParams.toString()}`
      
      console.log(`📊 Proxying 0x Swap API v2 quote request to ${baseUrl}...`)
      console.log(`  URL: ${url}`)
      console.log(`  Sell Token: ${sellToken}`)
      console.log(`  Buy Token: ${buyToken}`)
      console.log(`  Sell Amount: ${sellAmount}`)
      console.log(`  Slippage: ${slippagePercentage}%`)

      try {
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
          
          console.error(`❌ 0x API error from ${baseUrl}:`, {
            status: response.status,
            statusText: response.statusText,
            error: errorData,
          })
          
          // Handle "no Route matched" error specifically (400 status)
          if (response.status === 400 && (
            errorData.reason?.includes("no Route matched") || 
            errorData.message?.includes("no Route matched") ||
            errorData.error?.includes("no Route matched")
          )) {
            // If this is the last URL, return the error
            if (baseUrl === ZEROX_API_BASE_URLS[ZEROX_API_BASE_URLS.length - 1]) {
              return NextResponse.json(
                { 
                  error: "Insufficient liquidity for this swap amount. Please try a smaller amount or wait for more liquidity.",
                  code: "NO_ROUTE_MATCHED"
                },
                { status: 400 }
              )
            }
            // Otherwise, try next URL
            lastError = errorData
            continue
          }
          
          // Handle v2 API issues array
          if (errorData.issues && Array.isArray(errorData.issues)) {
            const errorMessages = errorData.issues
              .filter((issue: any) => issue.severity === "error")
              .map((issue: any) => issue.reason)
              .join(", ")
            
            // If this is the last URL, return the error
            if (baseUrl === ZEROX_API_BASE_URLS[ZEROX_API_BASE_URLS.length - 1]) {
              return NextResponse.json(
                { error: `0x API v2 error: ${errorMessages || errorData.reason || errorData.message || response.statusText}` },
                { status: response.status }
              )
            }
            // Otherwise, try next URL
            lastError = errorData
            continue
          }
          
          // If this is the last URL, return the error
          if (baseUrl === ZEROX_API_BASE_URLS[ZEROX_API_BASE_URLS.length - 1]) {
            return NextResponse.json(
              { error: `0x API v2 error: ${errorData.reason || errorData.message || response.statusText}` },
              { status: response.status }
            )
          }
          
          // Otherwise, try next URL
          lastError = errorData
          continue
        }

        // Success - parse and return quote data
        quoteData = await response.json()
        console.log(`✅ 0x API v2 Quote received from ${baseUrl}`)
        break
      } catch (fetchError: any) {
        console.error(`❌ Error fetching from ${baseUrl}:`, fetchError)
        lastError = fetchError
        
        // If this is the last URL, throw the error
        if (baseUrl === ZEROX_API_BASE_URLS[ZEROX_API_BASE_URLS.length - 1]) {
          throw fetchError
        }
        // Otherwise, try next URL
        continue
      }
    }

    if (!quoteData) {
      return NextResponse.json(
        { error: "Failed to fetch quote from all 0x API endpoints" },
        { status: 500 }
      )
    }

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
