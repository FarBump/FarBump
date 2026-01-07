import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Mengambil parameter dari frontend
  const sellToken = searchParams.get("sellToken");
  const buyToken = searchParams.get("buyToken");
  const sellAmount = searchParams.get("sellAmount");
  const taker = searchParams.get("takerAddress");

  // Validasi parameter wajib
  if (!sellToken || !buyToken || !sellAmount || !taker) {
    return NextResponse.json(
      { error: "Missing required parameters (sellToken, buyToken, sellAmount, takerAddress)" },
      { status: 400 }
    );
  }

  try {
    // Parameter Query sesuai dokumentasi 0x v2 AllowanceHolder
    const queryParams = new URLSearchParams({
      chainId: "8453", // Base Mainnet
      sellToken,
      buyToken,
      sellAmount,
      taker,
      // Karena likuiditas $BUMP di v4 sangat tipis, kita gunakan slippage 10% (1000 Bps)
      // agar rute tetap bisa ditemukan meskipun price impact tinggi.
      slippageBps: "1000", 
    });

    // Menggunakan Endpoint Allowance-Holder (Recommended for Smart Wallets)
    const apiUrl = `https://api.0x.org/swap/allowance-holder/quote?${queryParams.toString()}`;

    const response = await fetch(apiUrl, {
      headers: {
        "0x-api-key": process.env.ZEROX_API_KEY || "",
        "0x-version": "v2",
        "Accept": "application/json",
      },
    });

    const data = await response.json();

    // Logika Logging untuk memantau pool v4 dan Hook Anda
    if (!response.ok) {
      console.error("--- 0x API ERROR ---");
      console.error("Reason:", data.reason || data.message);
      console.error("Details:", JSON.stringify(data, null, 2));
      
      return NextResponse.json(
        { 
          error: data.reason || "No Route Matched", 
          message: "Kemungkinan likuiditas terlalu rendah atau simulasi hook gagal.",
          details: data 
        }, 
        { status: response.status }
      );
    }

    // Jika berhasil, log informasi rute
    console.log("--- 0x SWAP QUOTE SUCCESS ---");
    console.log("Source Pool:", data.route?.fills?.[0]?.source || "Unknown");
    console.log("Buy Amount:", data.buyAmount);

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("Internal Server Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message }, 
      { status: 500 }
    );
  }
}
