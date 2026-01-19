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
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
});

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[${requestId}] Batch Execution Started...`);

  try {
    const { botWalletAddresses, tokenAddress, recipientAddress } = await request.json();
    const supabase = createSupabaseServiceClient();
    const cdp = new CdpClient();
    const results = [];

    // Menggunakan loop for...of agar eksekusi berurutan (mencegah tabrakan Nonce)
    for (const botAddress of botWalletAddresses) {
      console.log(`[${requestId}] Processing: ${botAddress}`);
      
      try {
        const { data: walletData } = await supabase
          .from("wallets_data")
          .select("owner_address")
          .ilike("smart_account_address", botAddress)
          .single();

        if (!walletData) throw new Error("Wallet not found in DB");

        const ownerAccount = await cdp.evm.getAccount({ address: walletData.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: botAddress as Address });

        // 1. Cek Saldo Native & WETH
        const [nativeBalance, wethBalance] = await Promise.all([
          publicClient.getBalance({ address: botAddress as Address }),
          publicClient.readContract({ address: WETH_ADDRESS, abi: WETH_ABI, functionName: "balanceOf", args: [botAddress as Address] })
        ]);

        // 2. Unwrap jika ETH < $0.1 (30.000 gwei)
        if (nativeBalance < 30000000000000n && wethBalance > 0n) {
          console.log(`[${botAddress}] Step 1: Unwrapping WETH...`);
          await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: [{ to: WETH_ADDRESS, data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [wethBalance] }) }],
            isSponsored: true 
          });
          // Delay minimal agar saldo terdeteksi oleh Bundler di transaksi berikutnya
          await new Promise(r => setTimeout(r, 1500));
        }

        // 3. Swap Token
        const tokenBalance = await publicClient.readContract({
          address: tokenAddress as Address, abi: WETH_ABI, functionName: "balanceOf", args: [botAddress as Address]
        });

        if (tokenBalance > 0n) {
          const quoteRes = await fetch(`https://api.0x.org/swap/allowance-holder/quote?chainId=8453&sellToken=${tokenAddress}&buyToken=${WETH_ADDRESS}&sellAmount=${tokenBalance.toString()}&taker=${botAddress.toLowerCase()}&slippageBps=1000`, {
            headers: { "0x-api-key": process.env.ZEROX_API_KEY || "", "0x-version": "v2" },
          });

          const quote = await quoteRes.json();
          if (!quoteRes.ok) throw new Error(`0x Quote Error: ${quote.reason}`);

          console.log(`[${botAddress}] Step 2: Executing Swap & Send...`);
          const opHash = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: [
              { to: tokenAddress as Address, data: encodeFunctionData({ abi: WETH_ABI, functionName: "approve", args: [quote.allowanceTarget || quote.transaction.to, tokenBalance] }) },
              { to: quote.transaction.to as Address, data: quote.transaction.data as Hex, value: 0n },
              { to: WETH_ADDRESS, data: encodeFunctionData({ abi: WETH_ABI, functionName: "transfer", args: [recipientAddress as Address, BigInt(quote.buyAmount)] }) }
            ],
            isSponsored: false,
            uoOverrides: { preVerificationGasMultiplier: 1.05 } // Bypass insufficient balance
          });

          results.push({ address: botAddress, status: "success", txHash: opHash });
        } else {
          results.push({ address: botAddress, status: "skipped", message: "No token balance" });
        }

      } catch (err: any) {
        console.error(`[${botAddress}] Failed:`, err.message);
        results.push({ address: botAddress, status: "error", message: err.message });
      }

      // Jeda antar bot disingkat menjadi 500ms
      await new Promise(r => setTimeout(r, 500));
    }

    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
