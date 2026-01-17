import { NextRequest, NextResponse } from "next/server";
import {
  type Address,
  type Hex,
  createPublicClient,
  http,
  encodeFunctionData,
  hexToSignature,
} from "viem";
import { base } from "viem/chains";
import { createSupabaseServiceClient } from "@/lib/supabase";
import { CdpClient } from "@coinbase/cdp-sdk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Constants
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;

const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { botWalletAddresses, tokenAddress, recipientAddress, symbol } = body;

    if (!botWalletAddresses || !Array.isArray(botWalletAddresses) || !tokenAddress || !recipientAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const supabase = createSupabaseServiceClient();

    // Inisialisasi CDP
    const apiKeyId = process.env.CDP_API_KEY_ID;
    const apiKeySecret = process.env.CDP_API_KEY_SECRET;

    if (!apiKeyId || !apiKeySecret) {
      return NextResponse.json({ error: "CDP credentials missing" }, { status: 500 });
    }

    const cdp = new CdpClient();
    const results = [];

    console.log(`🔄 Starting Swap to WETH for Token: ${tokenAddress}`);

    for (const botAddress of botWalletAddresses) {
      try {
        console.log(`🤖 Processing: ${botAddress}`);

        // 1. Ambil data dari wallets_data
        const { data: botWallet } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", botAddress)
          .single();

        if (!botWallet) {
          results.push({ address: botAddress, status: "error", message: "Wallet not found" });
          continue;
        }

        // 2. Cek saldo on-chain
        const balance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [botWallet.smart_account_address as Address],
        });

        if (balance === 0n) {
          results.push({ address: botAddress, status: "skipped", message: "Zero balance" });
          continue;
        }

        // 3. Inisialisasi Smart Account CDP V2
        const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({
          owner: ownerAccount,
          address: botWallet.smart_account_address as Address,
        });

        // 4. Get 0x API v2 Quote
        const params = new URLSearchParams({
          chainId: "8453",
          sellToken: tokenAddress,
          buyToken: WETH_ADDRESS,
          sellAmount: balance.toString(),
          taker: botWallet.smart_account_address.toString(),
          slippageBps: "500", // Default 5%
          skipValidation: "true",
          enableSlippageProtection: "false",
        });

        const quoteRes = await fetch(`https://api.0x.org/gasless/quote?${params.toString()}`, {
          headers: {
            "0x-api-key": process.env.ZEROX_API_KEY || "",
            "0x-version": "v2",
          },
        });
       
    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    console.error("Critical Error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
