import { NextRequest, NextResponse } from "next/server"

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ZEROX_API_KEY = process.env.ZEROX_API_KEY || ""

export async function GET(request: NextRequest) {
  try {
    if (!ZEROX_API_KEY) {
      return NextResponse.json({ error: "0x API key not configured" }, { status: 500 })
    }

    const searchParams = request.nextUrl.searchParams
    const sellToken = searchParams.get("sellToken")
    const buyToken = searchParams.get("buyToken")
    const sellAmount = searchParams.get("sellAmount")
    const takerAddress = searchParams.get("takerAddress")
    
    // 1. FORMAT SLIPPAGE: 0x API v2 mengharapkan desimal (0.01 = 1%)
    // Kita ambil input, jika user kirim "20", kita bagi 100 menjadi "0.2"
    let slippageInput = searchParams.get("slippagePercentage") || "0.5"
    let slippagePercentage = parseFloat(slippageInput)
    if (slippagePercentage > 1) {
      slippagePercentage = slippagePercentage / 100
    }

    if (!sellToken || !buyToken || !sellAmount || !takerAddress) {
      return NextResponse.json(
        { error: "Missing required parameters: sellToken, buyToken, sellAmount, takerAddress" },
        { status: 400 }
      )
    }

    // 2. TAMBAHKAN PARAMETER "FORCE EXECUTION" (Sesuai cara Farcaster/Settler)
    const queryParams = new URLSearchParams({
      chainId: "8453", 
      sellToken,
      buyToken,
      sellAmount,
      takerAddress,
      slippagePercentage: slippagePercentage.toString(),
      enablePermit2: "true",
      includePriceImpact: "true",
      // Bypass guardrails: Izinkan swap meskipun price impact tinggi
      enableSlippageProtection: "false", 
      // Force API: Cari rute apapun yang tersedia untuk mengisi order
      intentOnFill: "true" 
    })

    // Menggunakan endpoint /swap/v2/quote sesuai dokumentasi terbaru Settler
    const apiUrl = `https://api.0x.org/swap/v2/quote?${queryParams.toString()}`

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "0x-api-key": ZEROX_API_KEY,
        "0x-version": "v2",
        "Accept": "application/json",
      },
    })

    const responseData = await response.json()

    if (!response.ok) {
      console.error(`❌ 0x API error:`, responseData)
      // Kembalikan error dalam bahasa Inggris yang jelas
      return NextResponse.json(
        { error: responseData.reason || responseData.message || "Insufficient liquidity for this trade." },
        { status: response.status }
      )
    }

    // 3. LOGIKA UNTUK UI (English Logging)
    console.log(`✅ Quote received. Impact: ${responseData.estimatedPriceImpact}%`)

    return NextResponse.json(responseData)
  } catch (error: any) {
    console.error("❌ Proxy Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
