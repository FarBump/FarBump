import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Ambil parameter dari frontend
  const sellToken = searchParams.get("sellToken");
  const buyToken = searchParams.get("buyToken");
  const sellAmount = searchParams.get("sellAmount");
  const takerAddress = searchParams.get("takerAddress");
  const slippageInput = searchParams.get("slippagePercentage") || "3";

  // Konversi slippage: jika frontend kirim "3", jadi 0.03
  const slippagePercentage = parseFloat(slippageInput) / 100;

  if (!sellToken || !buyToken || !sellAmount || !takerAddress) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
  }

  try {
    const queryParams = new URLSearchParams({
      chainId: "8453", // Base Mainnet
      sellToken,
      buyToken,
      sellAmount,
      takerAddress,
      slippagePercentage: slippagePercentage.toString(),
      enablePermit2: "true",
      intentOnFill: "true", // WAJIB untuk Settler
      enableSlippageProtection: "false", // MEMAKSA rute meskipun liquidity rendah
    });

    const ZEROX_API_KEY = process.env.ZEROX_API_KEY;
    if (!ZEROX_API_KEY) {
      console.error("0x API Key is missing in environment variables");
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }

    // Menggunakan API v2 /swap/v2/quote
    const apiUrl = `https://api.0x.org/swap/v2/quote?${queryParams.toString()}`;
    
    console.log("📡 Proxying request to 0x API v2...");

    const response = await fetch(apiUrl, {
      headers: {
        "0x-api-key": ZEROX_API_KEY,
        "Accept": "application/json",
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ 0x API Error Details:", data);
      return NextResponse.json(
        { error: data.reason || data.message || "0x API returned an error", details: data },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("❌ Proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
