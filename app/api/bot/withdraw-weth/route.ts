import { NextRequest, NextResponse } from "next/server"
import { type Address, type Hex, encodeFunctionData, createPublicClient, http, hexToSignature } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
// PERBAIKAN: Menggunakan Namespace Import agar semua sub-modul terdeteksi saat build
import * as CDP from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// 1. Inisialisasi Konfigurasi CDP
const privateKey = process.env.CDP_API_KEY_PRIVATE_KEY
  ? process.env.CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, '\n')
  : "";

// Menggunakan CDP.Coinbase untuk menghindari error export
CDP.Coinbase.configure({
  apiKeyName: process.env.CDP_API_KEY_NAME || "",
  privateKey: privateKey,
});

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const
const WETH_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { botWalletAddresses, tokenAddress, recipientAddress } = body;

    console.log("--- START WITHDRAW PROCESS ---");
    console.log(`Target Token: ${tokenAddress}`);
    console.log(`Recipient: ${recipientAddress}`);

    const supabase = createSupabaseServiceClient();
    const results = [];

    for (const rawAddress of botWalletAddresses) {
      try {
        console.log(`\n[Processing Bot: ${rawAddress}]`);

        const { data: bot, error: dbError } = await supabase
          .from("wallets_data")
          .select("id, owner_address, smart_account_address")
          .ilike("smart_account_address", rawAddress)
          .single();

        if (dbError || !bot) throw new Error(`Bot record not found for ${rawAddress}`);
        console.log(`- DB Check: Found Owner Wallet ID ${bot.id}`);

        // 2. Fetch Owner Wallet menggunakan namespace CDP
        const ownerWallet = await CDP.Wallet.fetch(bot.id);
        console.log("- CDP Check: Owner Wallet instance fetched successfully");
        
        // 3. Inisialisasi Smart Account
        const smartAccount = await ownerWallet.getSmartAccount(bot.smart_account_address as Address);

        // 4. Cek Saldo
        const rawBalanceWei = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [bot.smart_account_address as Address],
        });
        
        const cleanBalanceWei = BigInt(rawBalanceWei.toString().split('.')[0]);
        console.log(`- Balance Check: ${cleanBalanceWei.toString()} Wei`);

        if (cleanBalanceWei > 0n) {
          // 5. Fetch Quote 0x
          const query = new URLSearchParams({
            chainId: "8453",
            sellToken: (tokenAddress as string).toLowerCase(),
            buyToken: WETH_ADDRESS.toLowerCase(),
            sellAmount: cleanBalanceWei.toString(),
            taker: bot.smart_account_address.toLowerCase(),
          });

          const quoteUrl = `https://api.0x.org/gasless/quote?${query.toString()}`;
          console.log("- Fetching 0x Quote...");

          const quoteRes = await fetch(quoteUrl, {
            headers: { 
              "0x-api-key": process.env.ZEROX_API_KEY || "", 
              "0x-version": "v2" 
            }
          });
          
          const quote = await quoteRes.json();
          if (!quoteRes.ok) {
            console.error("- 0x API Error Details:", JSON.stringify(quote, null, 2));
            throw new Error(quote.reason || "0x Quote Failed");
          }
          console.log("- 0x Quote received successfully");

          // 6. Signature
          console.log("- Generating EIP-712 Signature via CDP...");
          const eip712 = quote.trade.eip712;
          const signatureHex = await ownerWallet.createPayloadSignature({
            domain: eip712.domain,
            types: eip712.types,
            primaryType: eip712.primaryType,
            message: eip712.message,
          });

          const sig = hexToSignature(signatureHex as Hex);
          const r = sig.r.padStart(66, '0x');
          const s = sig.s.padStart(66, '0x');
          const v = sig.v.toString(16).padStart(2, '0');
          const signatureType = "02"; 
          
          const paddedSignature = `${r}${s.replace('0x','')}${v}${signatureType}` as Hex;
          const sigLengthHex = (paddedSignature.replace('0x','').length / 2).toString(16).padStart(64, '0');
          const finalCallData = `${quote.trade.transaction.data}${sigLengthHex}${paddedSignature.replace('0x','')}` as Hex;
          console.log("- Signature formatted and attached");

          // 7. Execute Swap
          console.log("- Sending Swap UserOperation (Sponsored)...");
          const swapOp = await smartAccount.sendUserOperation({
            calls: [
              {
                to: tokenAddress as Address,
                data: encodeFunctionData({
                  abi: WETH_ABI,
                  functionName: "approve",
                  args: [quote.trade.clearinghouse as Address, cleanBalanceWei],
                }),
              },
              {
                to: quote.trade.transaction.to as Address,
                data: finalCallData,
              }
            ],
          });
          
          console.log("- Waiting for Swap confirmation...");
          await swapOp.wait();
          console.log("- Swap successful!");
          
          await new Promise(r => setTimeout(r, 2000));
        }

        // 8. Final Transfer
        const rawFinalWeth = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [bot.smart_account_address as Address],
        });
        
        const cleanFinalWeth = BigInt(rawFinalWeth.toString().split('.')[0]);
        console.log(`- Final WETH Balance: ${cleanFinalWeth.toString()}`);

        if (cleanFinalWeth > 0n) {
          console.log("- Sending WETH Transfer to recipient...");
          const transferOp = await smartAccount.sendUserOperation({
            calls: [{
              to: WETH_ADDRESS,
              data: encodeFunctionData({ 
                abi: WETH_ABI, 
                functionName: "transfer", 
                args: [recipientAddress as Address, cleanFinalWeth] 
              }),
            }],
          });
          await transferOp.wait();
          console.log("- Transfer successful!");
        }

        results.push({ address: bot.smart_account_address, status: "success" });

      } catch (err: any) {
        console.error(`[FATAL ERROR] for ${rawAddress}:`, err.message);
        results.push({ address: rawAddress, status: "failed", error: err.message });
      }
    }

    console.log("--- PROCESS COMPLETE ---");
    return NextResponse.json({ success: true, details: results });

  } catch (error: any) {
    console.error("Critical API Error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
