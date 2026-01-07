import { NextRequest, NextResponse } from "next/server";



export async function GET(request: NextRequest) {

  const { searchParams } = new URL(request.url);



  // Mengambil parameter dari frontend

  const sellToken = searchParams.get("sellToken");

  const sellAmount = searchParams.get("sellAmount");

  const taker = searchParams.get("takerAddress");



  // Validasi parameter wajib

  if (!sellToken || !sellAmount || !taker) {

    return NextResponse.json(

      { error: "Missing required parameters (sellToken, sellAmount, takerAddress)" },

      { status: 400 }

    );

  }



  try {

    // Parameter Query yang disesuaikan untuk Native ETH Output

    const queryParams = new URLSearchParams({

      chainId: "8453", // Base Mainnet

      sellToken: sellToken,

      // PAKSA KE ETH: Menjamin output adalah Native ETH untuk operasional Bot

      buyToken: "ETH", 

      sellAmount: sellAmount,

      taker: taker,

      // Slippage 1000 (10%) karena LP Uniswap v4 $BUMP yang sangat tipis

      slippageBps: "1000", 

    });



    // Menggunakan Endpoint Allowance-Holder sesuai rekomendasi 0x v2

    const apiUrl = `https://api.0x.org/swap/allowance-holder/quote?${queryParams.toString()}`;



    const response = await fetch(apiUrl, {

      headers: {

        "0x-api-key": process.env.ZEROX_API_KEY || "",

        "0x-version": "v2",

        "Accept": "application/json",

      },

    });



    const data = await response.json();



    // Logika Error Handling & Logging

    if (!response.ok) {

      console.error("--- 0x API ERROR (Bot Convert) ---");

      console.error("Reason:", data.reason || data.message);

      

      // Jika error karena likuiditas (biasa terjadi pada pool tipis)

      if (data.reason === "INSUFFICIENT_ASSET_LIQUIDITY") {

         console.warn("Likuiditas $BUMP v4 terlalu tipis untuk jumlah ini.");

      }



      return NextResponse.json(

        { 

          error: data.reason || "No Route Matched", 

          message: "Gagal menemukan rute swap. Coba kurangi jumlah token.",

          details: data 

        }, 

        { status: response.status }

      );

    }



    // Berhasil: Log info untuk memantau pool Uniswap v4

    console.log("--- BUMP TO ETH CONVERT SUCCESS ---");

    console.log("Source:", data.route?.fills?.[0]?.source || "Uniswap_V4");

    console.log("ETH Output:", data.buyAmount);



    return NextResponse.json(data);

  } catch (error: any) {

    console.error("Internal Server Error:", error);

    return NextResponse.json(

      { error: "Internal Server Error", details: error.message }, 

      { status: 500 }

    );

  }

}
