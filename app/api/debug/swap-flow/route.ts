import { NextRequest, NextResponse } from "next/server";
import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createSupabaseServiceClient } from "@/lib/supabase";

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], type: "function" },
  { inputs: [{ name: "wad", type: "uint256" }], name: "withdraw", outputs: [], type: "function" },
] as const;

export async function POST(req: NextRequest) {
  try {
    const { botAddress, tokenAddress } = await req.json();
    const supabase = createSupabaseServiceClient();

    // 1. Ambil data wallet dari DB
    const { data: botWallet } = await supabase
      .from("wallets_data")
      .select("*")
      .ilike("smart_account_address", botAddress)
      .single();

    if (!botWallet) throw new Error("Wallet not found in database");

    const cdp = new CdpClient();
    const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address });
    const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: botAddress as Address });

    const publicClient = createPublicClient({ chain: base, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });

    // 2. Cek Saldo WETH & Token Target
    const [wethBalance, tokenBalance] = await Promise.all([
      publicClient.readContract({ address: WETH_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
      publicClient.readContract({ address: tokenAddress as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
    ]);

    // 3. Get 0x Quote (0x API v2)
    const quoteParams = new URLSearchParams({
      chain: "base",
      sellToken: tokenAddress,
      buyToken: WETH_ADDRESS,
      sellAmount: tokenBalance.toString(),
      taker: botAddress,
    });

    const quoteRes = await fetch(`https://api.0x.org/swap/v2/quote?${quoteParams.toString()}`, {
      headers: { "0x-api-key": process.env.ZEROX_API_KEY!, "0x-version": "v2" },
    });
    const quote = await quoteRes.json();
    if (!quoteRes.ok) throw new Error(quote.reason || "0x Quote Error");

    // 4. Batch: Unwrap WETH (Gasless via Paymaster) -> Swap Token (Bayar Gas pakai hasil Unwrap)
    const op = await smartAccount.sendUserOperation({
      calls: [
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "withdraw", args: [wethBalance] }),
        },
        {
          to: tokenAddress as Address,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [quote.transaction.to as Address, tokenBalance] }),
        },
        {
          to: quote.transaction.to as Address,
          data: quote.transaction.data as Hex,
          value: BigInt(quote.transaction.value),
        },
      ],
    });

    await op.wait();
    return NextResponse.json({ success: true, txHash: op.userOpHash });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
