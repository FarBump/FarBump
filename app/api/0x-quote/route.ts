import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const sellToken = searchParams.get("sellToken");
  const sellAmount = searchParams.get("sellAmount");
  const taker = searchParams.get("takerAddress");

  if (!sellToken || !sellAmount || !taker) {
    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  }

  try {
    const queryParams = new URLSearchParams({
      chainId: "8453",
      sellToken: sellToken,
      // Gunakan alamat WETH asli Base karena pool Anda ada di sini
      buyToken: "0x4200000000000000000000000000000000000006", 
      sellAmount: sellAmount,
      taker: taker,
      slippageBps: "1500", // 15% slippage karena LP tipis
      enableSlippageProtection: "false",
    });

    const response = await fetch(
      `https://api.0x.org/swap/allowance-holder/quote?${queryParams.toString()}`,
      {
        headers: {
          "0x-api-key": process.env.ZEROX_API_KEY || "",
          "0x-version": "v2",
        },
      }
    );

    const data = await response.json();
    if (!response.ok) return NextResponse.json(data, { status: response.status });

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
