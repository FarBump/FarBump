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
    // 0x API v2 menggunakan Basis Points (Bps)
    // 100 Bps = 1%, jadi 300 Bps = 3%
    const queryParams = new URLSearchParams({
      chainId: "8453", // Base Mainnet
      sellToken,
      buyToken,
      sellAmount,
      taker, 
      slippageBps: "300", 
      enablePermit2: "true",
    });

    const response = await fetch(`https://api.0x.org/swap/v2/quote?${queryParams.toString()}`, {
      headers: {
        "0x-api-key": process.env.ZEROX_API_KEY || "",
        "0x-version": "v2", // WAJIB untuk Uniswap v4
        "Accept": "application/json",
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("0x API v2 Error:", data);
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Internal API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
