import { NextRequest, NextResponse } from "next/server";
import { formatEther, type Address, type Hex, createPublicClient, http, encodeFunctionData, isAddress } from "viem";
import { base } from "viem/chains";
import { createSupabaseServiceClient } from "@/lib/supabase";
import { CdpClient } from "@coinbase/cdp-sdk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
const TARGET_TOKEN_ADDRESS = "0x8984B389cB82e05016DB2E4c7230ca0791b9Cb07" as const;

const WETH_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
});

export async function POST(req: NextRequest) {
  try {
    const { botAddress } = await req.json();
    const supabase = createSupabaseServiceClient();

    // 1. Ambil data wallet & kredet dari database
    const { data: botWallet } = await supabase.from("wallets_data").select("*").ilike("smart_account_address", botAddress).single();
    if (!botWallet) throw new Error("Wallet not found in database");

    const { data: creditRecord } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei")
      .eq("bot_wallet_address", botAddress.toLowerCase())
      .single();

    const wethBalanceWei = creditRecord ? BigInt(creditRecord.weth_balance_wei || "0") : 0n;
    if (wethBalanceWei === 0n) throw new Error("WETH balance in DB is 0. Please distribute credit.");

    // 2. Inisialisasi CDP SDK V2
    const cdp = new CdpClient();
    const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address });
    const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: botAddress as Address });

    // 3. Get Quote dari 0x API v2 (Allowance Holder) - Dioptimalkan untuk Uniswap v4 Hook
    console.log(`📊 Fetching quote for ${formatEther(wethBalanceWei)} WETH...`);
    const quoteParams = new URLSearchParams({
      chainId: "8453",
      sellToken: WETH_ADDRESS,
      buyToken: TARGET_TOKEN_ADDRESS,
      sellAmount: wethBalanceWei.toString(),
      taker: botAddress.toLowerCase(),
      slippageBps: "1000", // 10% Slippage untuk Clanker/Hook
    });

    const quoteRes = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`, {
      headers: { "0x-api-key": process.env.ZEROX_API_KEY!, "0x-version": "v2" },
    });

    const quote = await quoteRes.json();
    if (!quoteRes.ok) throw new Error(`0x Error: ${quote.reason || "No Route"}`);

    // 4. Cek Allowance
    const allowanceTarget = quote.allowanceTarget || quote.transaction.to;
    const currentAllowance = await publicClient.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "allowance",
      args: [botAddress as Address, allowanceTarget as Address],
    });

    const calls = [];

    // 5. Tambahkan Call Approve jika diperlukan
    if (currentAllowance < wethBalanceWei) {
      console.log("🔐 Adding approval call...");
      calls.push({
        to: WETH_ADDRESS,
        data: encodeFunctionData({
          abi: WETH_ABI,
          functionName: "approve",
          args: [allowanceTarget as Address, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
        }),
      });
    }

    // 6. Tambahkan Call Swap
    calls.push({
      to: quote.transaction.to as Address,
      data: quote.transaction.data as Hex,
      value: 0n, // WETH swap selalu 0 value
    });

    // 7. Eksekusi via UserOperation (Sponsored/Gasless)
    console.log("🚀 Sending UserOperation...");
    const op = await (smartAccount as any).sendUserOperation({
      calls,
      network: "base",
    });

    const opHash = typeof op === 'string' ? op : (op.hash || op.userOpHash);
    console.log(`✅ UserOp submitted: ${opHash}`);

    // Tunggu konfirmasi
    await (smartAccount as any).waitForUserOperation({ userOpHash: opHash, network: "base" });

    // 8. Sync Database (Kurangi saldo WETH yang terpakai)
    await supabase.from("bot_wallet_credits")
      .update({ weth_balance_wei: "0" }) // Set 0 karena kita swap "All"
      .eq("bot_wallet_address", botAddress.toLowerCase());

    return NextResponse.json({ success: true, txHash: opHash });

  } catch (error: any) {
    console.error("❌ Swap-Flow Error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
