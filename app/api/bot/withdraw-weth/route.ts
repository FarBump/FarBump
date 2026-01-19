import { NextRequest, NextResponse } from "next/server";
import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createSupabaseServiceClient } from "@/lib/supabase";
import { CdpClient } from "@coinbase/cdp-sdk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;

const WETH_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

// Menggunakan RPC URL dari .env untuk menghindari rate limit publik
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
});

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[${requestId}] Starting Withdrawal Process...`);

  try {
    const { botWalletAddresses, tokenAddress, recipientAddress } = await request.json();
    const supabase = createSupabaseServiceClient();
    const cdp = new CdpClient();
    const results = [];

    for (const botAddress of botWalletAddresses) {
      console.log(`\n[${requestId}] Bot: ${botAddress}`);
      
      try {
        const { data: walletData } = await supabase
          .from("wallets_data")
          .select("owner_address")
          .ilike("smart_account_address", botAddress)
          .single();

        if (!walletData) throw new Error(`DB_ERROR: Owner not found`);

        const ownerAccount = await cdp.evm.getAccount({ address: walletData.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: botAddress as Address });

        // --- STEP 1: UNWRAP ALL WETH (SPONSORED) ---
        const wethBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [botAddress as Address],
        });

        console.log(`[${requestId}] [STEP 1] Found WETH: ${wethBalance.toString()}`);

        if (wethBalance > 0n) {
          try {
            console.log(`[${requestId}] [STEP 1] Unwrapping all WETH for gas...`);
            await (smartAccount as any).sendUserOperation({
              network: "base",
              calls: [{
                to: WETH_ADDRESS,
                data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [wethBalance] }),
              }],
              isSponsored: true 
            });
            // Tunggu 2 detik agar saldo Native ETH ter-update di node
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (e: any) {
            console.warn(`[${requestId}] [STEP 1] Unwrap failed (trying to proceed):`, e.message);
          }
        }

        // --- STEP 2: SWAP TOKEN (NO MINIMUM) ---
        const tokenBalance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [botAddress as Address],
        });

        if (tokenBalance === 0n) {
          console.log(`[${requestId}] [STEP 2] Skip: Token balance 0`);
          continue;
        }

        const quoteParams = new URLSearchParams({
          chainId: "8453",
          sellToken: tokenAddress,
          buyToken: WETH_ADDRESS,
          sellAmount: tokenBalance.toString(),
          taker: botAddress.toLowerCase(),
          slippageBps: "1000",
        });

        const quoteRes = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`, {
          headers: { "0x-api-key": process.env.ZEROX_API_KEY || "", "0x-version": "v2" },
        });

        const quote = await quoteRes.json();
        if (!quoteRes.ok) throw new Error(`0X_QUOTE_FAILED: ${quote.reason}`);

        // --- STEP 3: FINAL EXECUTION ---
        const allowanceTarget = quote.allowanceTarget || quote.transaction.to;
        const finalOp = await (smartAccount as any).sendUserOperation({
          network: "base",
          calls: [
            {
              to: tokenAddress as Address,
              data: encodeFunctionData({ abi: WETH_ABI, functionName: "approve", args: [allowanceTarget as Address, tokenBalance] }),
            },
            {
              to: quote.transaction.to as Address,
              data: quote.transaction.data as Hex,
              value: 0n,
            },
            {
              to: WETH_ADDRESS,
              data: encodeFunctionData({ abi: WETH_ABI, functionName: "transfer", args: [recipientAddress as Address, BigInt(quote.buyAmount)] }),
            }
          ],
          isSponsored: false 
        });

        console.log(`[${requestId}] [STEP 3] Success: ${finalOp}`);
        results.push({ address: botAddress, status: "success", txHash: finalOp });

      } catch (err: any) {
        console.error(`[${requestId}] Error:`, err.message);
        results.push({ address: botAddress, status: "error", message: err.message });
      }
      
      // Jeda 1 detik antar bot agar 0x API tidak rate limit
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
