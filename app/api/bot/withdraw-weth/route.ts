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

const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
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
      console.log(`\n[${requestId}] Processing Bot: ${botAddress}`);
      
      try {
        // 1. Fetch Owner Data
        const { data: walletData, error: dbError } = await supabase
          .from("wallets_data")
          .select("owner_address")
          .ilike("smart_account_address", botAddress)
          .single();

        if (dbError || !walletData) {
          throw new Error(`DB_ERROR: Owner not found for ${botAddress}`);
        }

        const ownerAccount = await cdp.evm.getAccount({ address: walletData.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: botAddress as Address });

        // --- STEP 1: UNWRAP WETH (SPONSORED) ---
        console.log(`[${requestId}] [STEP 1] Checking WETH for gas unwrap...`);
        const gasAmount = 500000000000000n; // 0.0005 ETH
        
        const wethBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [botAddress as Address],
        });

        if (wethBalance < gasAmount) {
          console.warn(`[${requestId}] [STEP 1] Skip Unwrap: WETH balance too low (${wethBalance.toString()})`);
        } else {
          console.log(`[${requestId}] [STEP 1] Sending Sponsored Unwrap UserOp...`);
          try {
            const unwrapOp = await (smartAccount as any).sendUserOperation({
              network: "base",
              calls: [{
                to: WETH_ADDRESS,
                data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [gasAmount] }),
              }],
              isSponsored: true 
            });
            console.log(`[${requestId}] [STEP 1] Unwrap Success! Hash: ${unwrapOp}`);
          } catch (unwrapErr: any) {
            console.error(`[${requestId}] [STEP 1] Unwrap Failed:`, unwrapErr.message);
            throw new Error(`UNWRAP_FAILED: ${unwrapErr.message}`);
          }
        }

        // --- STEP 2: GET QUOTE 0X ---
        console.log(`[${requestId}] [STEP 2] Fetching 0x Quote...`);
        const tokenBalance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [botAddress as Address],
        });

        if (tokenBalance === 0n) {
          console.log(`[${requestId}] [STEP 2] Skip: Token balance is 0`);
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
        if (!quoteRes.ok) {
          throw new Error(`0X_QUOTE_FAILED: ${quote.reason || "Unknown reason"}`);
        }
        console.log(`[${requestId}] [STEP 2] 0x Quote Received. Expected Out: ${quote.buyAmount}`);

        // --- STEP 3: FINAL SWAP & SEND (PAID BY NATIVE ETH) ---
        console.log(`[${requestId}] [STEP 3] Sending Final UserOp (Bypass Allowlist)...`);
        const allowanceTarget = quote.allowanceTarget || quote.transaction.to;

        try {
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
          console.log(`[${requestId}] [STEP 3] Process Complete! Hash: ${finalOp}`);
          results.push({ address: botAddress, status: "success", txHash: finalOp });
        } catch (finalErr: any) {
          console.error(`[${requestId}] [STEP 3] Final Op Failed:`, finalErr.message);
          throw new Error(`FINAL_TX_FAILED: ${finalErr.message}`);
        }

      } catch (err: any) {
        console.error(`[${requestId}] Critical Error for Bot ${botAddress}:`, err.message);
        results.push({ address: botAddress, status: "error", errorType: err.message.split(':')[0], message: err.message });
      }
    }

    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    console.error(`[${requestId}] Global API Error:`, error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
