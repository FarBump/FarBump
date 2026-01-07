import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const sellToken = searchParams.get("sellToken");
  const buyToken = searchParams.get("buyToken");
  const sellAmount = searchParams.get("sellAmount");
  const taker = searchParams.get("takerAddress");

  if (!sellToken || !buyToken || !sellAmount || !taker) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
  }

  try {
    const queryParams = new URLSearchParams({
      chainId: "8453",
      sellToken,
      buyToken,
      sellAmount,
      taker,
      // 1. NAIKKAN SLIPPAGE: Kita gunakan 25% (2500 Bps) karena LP tipis
      // Ini memberi ruang bagi 0x untuk tetap memproses rute v4 meskipun harganya jatuh
      slippageBps: "2500", 
      
      // 2. MATIKAN PROTEKSI: Memaksa 0x tetap memberikan rute meskipun price impact tinggi
      enableSlippageProtection: "false",
      
      // 3. FITUR V4:
      enablePermit2: "true",
      intentOnFill: "true",
      includedSources: "Uniswap_V4",
    });

    const response = await fetch(`https://api.0x.org/swap/v2/quote?${queryParams.toString()}`, {
      headers: {
        "0x-api-key": process.env.ZEROX_API_KEY || "",
        "0x-version": "v2",
        "Accept": "application/json",
      },
    });

    const data = await response.json();

    // Log Audit untuk memantau Price Impact
    if (response.ok) {
      console.log("--- HIGH IMPACT QUOTE SUCCESS ---");
      console.log("Expected Buy Amount:", data.buyAmount);
      // Cek apakah 0x memberikan peringatan soal price impact
      if (data.issues?.priceImpact) {
        console.warn("Price Impact Warning:", data.issues.priceImpact);
      }
    } else {
      console.error("--- QUOTE FAILED ---", data.reason);
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
