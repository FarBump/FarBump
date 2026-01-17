import { NextRequest, NextResponse } from "next/server"
import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const
const WETH_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }
] as const

// Helper to prevent 'toLowerCase' on undefined/null
function ensureAddress(addr: any, fieldName: string): Address {
  if (!addr || typeof addr !== 'string' || addr === "undefined") {
    throw new Error(`Critical Error: ${fieldName} is missing or undefined`);
  }
  return addr.trim() as Address;
}

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { botWalletAddresses, tokenAddress, recipientAddress } = body;

    // Initial validation
    if (!botWalletAddresses || !Array.isArray(botWalletAddresses)) {
      return NextResponse.json({ success: false, error: "botWalletAddresses must be an array" }, { status: 400 });
    }

    const supabase = createSupabaseServiceClient();
    const cdp = new CdpClient();
    const results = [];

    // Pre-validate token and recipient before entering the loop
    const safeToken = ensureAddress(tokenAddress, "tokenAddress");
    const safeRecipient = ensureAddress(recipientAddress, "recipientAddress");

    for (const rawAddress of botWalletAddresses) {
      try {
        const safeBotAddress = ensureAddress(rawAddress, "botWalletAddress");

        // Fetch bot data from Supabase
        const { data: bot, error: dbError } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", safeBotAddress)
          .single();

        if (dbError || !bot) throw new Error(`Bot record not found in database for ${safeBotAddress}`);
        if (!bot.owner_address) throw new Error(`Owner address missing for bot ${safeBotAddress}`);

        // Initialize CDP Smart Account
        const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: safeBotAddress as Address });

        // 1. Check current token balance
        const balanceWei = await publicClient.readContract({
          address: safeToken,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [safeBotAddress],
        });

        if (balanceWei > 0n) {
          // 2. Fetch Gasless Quote from 0x v2
          const query = new URLSearchParams({
            chainId: "8453",
            sellToken: safeToken.toLowerCase(),
            buyToken: WETH_ADDRESS.toLowerCase(),
            sellAmount: balanceWei.toString(),
            taker: safeBotAddress.toLowerCase(),
          });

          const quoteRes = await fetch(`https://api.0x.org/gasless/quote?${query.toString()}`, {
            headers: { 
              "0x-api-key": process.env.ZEROX_API_KEY || "", 
              "0x-version": "v2" 
            }
          });

          const quote = await quoteRes.json();
          if (!quoteRes.ok) throw new Error(`0x Error: ${quote.reason || "Failed to fetch quote"}`);
          if (!quote.trade?.eip712) throw new Error("0x response missing trade EIP712 data");

          // 3. Sign EIP-712 Data
          const signature = await (smartAccount as any).signTypedData(quote.trade.eip712);
          
          // 4. Construct Final Data for Settler (Append Sig Length + Sig)
          const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
          const sigLengthHex = (sigHex.length / 2).toString(16).padStart(64, '0');
          const transactionData = quote.trade.transaction.data;
          const finalCallData = `${transactionData}${sigLengthHex}${sigHex}` as Hex;

          // 5. Execute Swap (Approve + Call)
          const swapOp = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: [
              {
                to: safeToken,
                data: encodeFunctionData({
                  abi: WETH_ABI,
                  functionName: "approve",
                  args: [quote.trade.clearinghouse as Address, balanceWei],
                }),
                value: 0n
              },
              {
                to: quote.trade.transaction.to as Address,
                data: finalCallData,
                value: 0n
              }
            ],
            isSponsored: true
          });
          await swapOp.wait();
          
          // Wait for state sync
          await new Promise(r => setTimeout(r, 2000));
        }

        // 6. Final Transfer of WETH to Main Wallet
        const finalWethBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [safeBotAddress],
        });

        if (finalWethBalance > 0n) {
          const transferOp = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: [{
              to: WETH_ADDRESS,
              data: encodeFunctionData({ 
                abi: WETH_ABI, 
                functionName: "transfer", 
                args: [safeRecipient, finalWethBalance] 
              }),
              value: 0n
            }],
            isSponsored: true
          });
          await transferOp.wait();
        }

        // 7. Update Credits in Database
        await supabase
          .from("bot_wallet_credits")
          .update({ weth_balance_wei: "0" })
          .eq("bot_wallet_address", safeBotAddress.toLowerCase());

        results.push({ address: safeBotAddress, status: "success" });

      } catch (err: any) {
        console.error(`Withdraw Error for ${rawAddress}:`, err.message);
        results.push({ address: rawAddress || "unknown", status: "failed", error: err.message });
      }
    }
    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
