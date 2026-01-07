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
      slippageBps: "500", // 5% toleransi untuk dynamic fee v4
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

    // LOG AUDIT: Untuk memantau interaksi dengan Hook 0xd60D...68Cc
    if (response.ok) {
      console.log("--- 0x v4 QUOTE SUCCESS ---");
      console.log("Buy Amount (Expected):", data.buyAmount);
      console.log("Estimated Gas:", data.transaction?.gas);
      if (data.route) {
        console.log("Route Source:", data.route.fills?.[0]?.source);
      }
    } else {
      console.error("--- 0x v4 QUOTE FAILED ---");
      console.error("Reason:", data.reason || data.message);
      console.error("Full Error Data:", JSON.stringify(data, null, 2));
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("System Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
