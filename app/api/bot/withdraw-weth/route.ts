import { NextRequest, NextResponse } from "next/server";
import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createSupabaseServiceClient } from "@/lib/supabase";
import { CdpClient } from "@coinbase/cdp-sdk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;

const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
] as const;

const publicClient = createPublicClient({
  chain: base,
  transport: http(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
});

export async function POST(request: NextRequest) {
  try {
    const { botWalletAddresses, tokenAddress, recipientAddress } = await request.json();

    if (!botWalletAddresses || !tokenAddress || !recipientAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const supabase = createSupabaseServiceClient();
    const cdp = new CdpClient();
    const results = [];

    for (const botAddress of botWalletAddresses) {
      try {
        const { data: walletData } = await supabase
          .from("wallets_data")
          .select("owner_address")
          .ilike("smart_account_address", botAddress)
          .single();

        if (!walletData) throw new Error("Owner not found");

        const balance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [botAddress as Address],
        });

        if (balance === 0n) continue;

        const quoteParams = new URLSearchParams({
          chainId: "8453",
          sellToken: tokenAddress,
          buyToken: WETH_ADDRESS,
          sellAmount: balance.toString(),
          taker: botAddress.toLowerCase(),
          slippageBps: "1000", 
        });

        const quoteRes = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`, {
          headers: { "0x-api-key": process.env.ZEROX_API_KEY || "", "0x-version": "v2" },
        });

        const quote = await quoteRes.json();
        if (!quoteRes.ok) throw new Error(quote.reason || "Quote failed");

        const ownerAccount = await cdp.evm.getAccount({ address: walletData.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: botAddress as Address });

        const allowanceTarget = quote.allowanceTarget || quote.transaction.to;
        const expectedWethOut = BigInt(quote.buyAmount);

        // IMPLEMENTASI FEE ABSTRACTION
        // Transaksi dibayar menggunakan WETH yang ada atau yang akan diterima di wallet tersebut
        const txOp = await (smartAccount as any).sendUserOperation({
          network: "base",
          calls: [
            {
              to: tokenAddress as Address,
              data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [allowanceTarget as Address, balance] }),
            },
            {
              to: quote.transaction.to as Address,
              data: quote.transaction.data as Hex,
              value: 0n,
            },
            {
              to: WETH_ADDRESS,
              data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [recipientAddress as Address, expectedWethOut] }),
            }
          ],
          // Menggunakan WETH sebagai token pembayaran gas
          feeToken: WETH_ADDRESS 
        });

        results.push({ address: botAddress, status: "success", txHash: txOp });
      } catch (err: any) {
        results.push({ address: botAddress, status: "error", message: err.message });
      }
    }

    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
