import { NextRequest, NextResponse } from "next/server";
import { 
  type Address, 
  type Hex, 
  encodeFunctionData, 
  createPublicClient, 
  http 
} from "viem";
import { base } from "viem/chains";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createSupabaseServiceClient } from "@/lib/supabase";

// Konfigurasi Alamat
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
const TARGET_TOKEN_ADDRESS = "0x8984B389cB82e05016DB2E4c7230ca0791b9Cb07" as const;

const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], type: "function", stateMutability: "view" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], type: "function", stateMutability: "nonpayable" },
  { inputs: [{ name: "wad", type: "uint256" }], name: "withdraw", outputs: [], type: "function", stateMutability: "nonpayable" },
] as const;

export async function POST(req: NextRequest) {
  try {
    const { botAddress } = await req.json();
    const supabase = createSupabaseServiceClient();

    // 1. Ambil data wallet dari database
    const { data: botWallet } = await supabase
      .from("wallets_data")
      .select("*")
      .ilike("smart_account_address", botAddress)
      .single();

    if (!botWallet) throw new Error("Wallet not found in database");

    // 2. Inisialisasi CDP Smart Account
    const cdp = new CdpClient();
    const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address });
    const smartAccount = await cdp.evm.getSmartAccount({ 
      owner: ownerAccount, 
      address: botAddress as Address 
    });

    const publicClient = createPublicClient({ 
      chain: base, 
      transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) 
    });

    // 3. Cek Saldo Token
    const [wethBalance, targetTokenBalance] = await Promise.all([
      publicClient.readContract({ address: WETH_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
      publicClient.readContract({ address: TARGET_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
    ]);

    if (targetTokenBalance === 0n) throw new Error("Saldo token $BUMP kosong. Tidak bisa swap.");

    // 4. Request Quote 0x V2 dengan Penyesuaian Hook
    // Kita menggunakan slippage tinggi dan mematikan validasi untuk mengakomodasi Hook
    const quoteParams = new URLSearchParams({
      chainId: "8453",
      sellToken: TARGET_TOKEN_ADDRESS,
      buyToken: WETH_ADDRESS,
      sellAmount: targetTokenBalance.toString(),
      taker: botAddress,
      slippageBps: "2000", // 20% Slippage (Sangat disarankan untuk pool dengan Hook/Tax)
      skipValidation: "true", // WAJIB: Agar 0x tidak mencoba mensimulasikan transaksi yang diproteksi Hook
      enableSlippageProtection: "true"
    });

    console.log(`🔍 Fetching 0x V2 Quote for $BUMP (Hook Active)...`);

    const quoteRes = await fetch(`https://api.0x.org/swap/v2/quote?${quoteParams.toString()}`, {
      headers: { "0x-api-key": process.env.ZEROX_API_KEY! },
    });

    const quote = await quoteRes.json();
    
    if (!quoteRes.ok) {
      console.error("❌ 0x V2 Quote Failed:", JSON.stringify(quote, null, 2));
      throw new Error(quote.reason || "0x API cannot find route for this Hooked Pool");
    }

    // Tentukan Spender (AllowanceHolder)
    const spender = quote.issues?.allowance?.spender || quote.transaction.to;

    /** * 5. Eksekusi Batch UserOperation
     * Urutan: 
     * 1. Withdraw WETH (Dapatkan bensin ETH)
     * 2. Approve Max (Mengakomodasi jika Hook butuh allowance lebih)
     * 3. Swap Call
     */
    const op = await smartAccount.sendUserOperation({
      calls: [
        // A. Dapatkan ETH untuk biaya transaksi/value swap
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({ 
            abi: ERC20_ABI, 
            functionName: "withdraw", 
            args: [wethBalance] 
          }),
        },
        // B. Approve Spender 0x (Menggunakan targetTokenBalance)
        {
          to: TARGET_TOKEN_ADDRESS,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [spender as Address, targetTokenBalance],
          }),
        },
        // C. Eksekusi Swap
        {
          to: quote.transaction.to as Address,
          data: quote.transaction.data as Hex,
          value: BigInt(quote.transaction.value),
        },
      ],
    });

    console.log("⏳ UserOp Hash:", op.userOpHash);
    await op.wait();

    return NextResponse.json({ 
      success: true, 
      txHash: op.userOpHash,
      message: "Swap V2 for Hooked Token completed" 
    });

  } catch (error: any) {
    console.error("❌ Swap-Flow Error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
