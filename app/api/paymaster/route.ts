import { NextRequest, NextResponse } from "next/server";

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const cdpUrl = process.env.CDP_PAYMASTER_URL;

    // Log untuk debugging (Cek di terminal VS Code Anda!)
    console.log("--- PROXY REQUEST RECEIVED ---");
    console.log("Using CDP URL:", cdpUrl ? "URL FOUND" : "URL NOT FOUND");

    if (!cdpUrl) {
      return NextResponse.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Server ENV not configured" }
      }, { status: 500 });
    }

    const body = await req.json();

    const response = await fetch(cdpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    
    // Jika Coinbase menolak karena allowlist, kita log di server
    if (data.error) {
      console.error("Coinbase RPC Error:", data.error.message);
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("Proxy Crash:", error);
    return NextResponse.json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: error.message }
    }, { status: 500 });
  }
}
