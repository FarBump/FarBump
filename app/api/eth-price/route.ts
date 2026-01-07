import { NextRequest, NextResponse } from "next/server"

// Cache ETH price for 30 seconds to reduce API calls
// This helps avoid rate limiting (429 errors) while still keeping price relatively fresh
let cachedPrice: { price: number; timestamp: number } | null = null
const CACHE_DURATION = 30000 // 30 seconds

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * API Route to fetch ETH price from CoinGecko
 * Server-side proxy to avoid CORS and rate limiting issues
 * 
 * Features:
 * - Server-side fetch (no CORS issues)
 * - 30-second caching to reduce API calls
 * - Graceful error handling
 * - Returns price in USD
 */
export async function GET(request: NextRequest) {
  try {
    // Check if we have a valid cached price
    if (cachedPrice && Date.now() - cachedPrice.timestamp < CACHE_DURATION) {
      return NextResponse.json({
        success: true,
        price: cachedPrice.price,
        cached: true,
        timestamp: cachedPrice.timestamp,
      })
    }

    // Fetch fresh price from CoinGecko
    const priceResponse = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      {
        headers: {
          Accept: "application/json",
        },
        // Add cache to reduce requests
        next: { revalidate: 30 }, // Revalidate every 30 seconds
      }
    )

    if (!priceResponse.ok) {
      // If we have a cached price, return it even if expired
      if (cachedPrice) {
        console.warn(
          `⚠️ CoinGecko API error (${priceResponse.status}), using cached price`
        )
        return NextResponse.json({
          success: true,
          price: cachedPrice.price,
          cached: true,
          stale: true,
          timestamp: cachedPrice.timestamp,
        })
      }

      // No cached price available, return error
      return NextResponse.json(
        {
          success: false,
          error: `CoinGecko API error: ${priceResponse.status} ${priceResponse.statusText}`,
        },
        { status: priceResponse.status }
      )
    }

    const priceData = await priceResponse.json()
    const ethPriceUsd = priceData.ethereum?.usd

    if (!ethPriceUsd || typeof ethPriceUsd !== "number") {
      // If we have a cached price, return it
      if (cachedPrice) {
        console.warn("⚠️ Invalid price data from CoinGecko, using cached price")
        return NextResponse.json({
          success: true,
          price: cachedPrice.price,
          cached: true,
          stale: true,
          timestamp: cachedPrice.timestamp,
        })
      }

      return NextResponse.json(
        {
          success: false,
          error: "Invalid price data from CoinGecko API",
        },
        { status: 500 }
      )
    }

    // Update cache
    cachedPrice = {
      price: ethPriceUsd,
      timestamp: Date.now(),
    }

    return NextResponse.json({
      success: true,
      price: ethPriceUsd,
      cached: false,
      timestamp: cachedPrice.timestamp,
    })
  } catch (error: any) {
    console.error("❌ Error fetching ETH price:", error)

    // If we have a cached price, return it even on error
    if (cachedPrice) {
      console.warn("⚠️ Error fetching ETH price, using cached price")
      return NextResponse.json({
        success: true,
        price: cachedPrice.price,
        cached: true,
        stale: true,
        timestamp: cachedPrice.timestamp,
      })
    }

    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to fetch ETH price",
      },
      { status: 500 }
    )
  }
}

