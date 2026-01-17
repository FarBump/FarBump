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

// Alamat Kontrak Utama
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

    // 3. Ambil Saldo (WETH untuk gas, Target Token untuk swap)
    const [wethBalance, targetTokenBalance] = await Promise.all([
      publicClient.readContract({ address: WETH_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
      publicClient.readContract({ address: TARGET_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
    ]);

    if (targetTokenBalance === 0n) throw new Error("Target token balance is zero");

    // 4. Request Quote dari 0x Swap API v2
    // Sesuai Docs: Menggunakan /swap/v2/quote
    const quoteParams = new URLSearchParams({
      chainId: "8453", // Base
      sellToken: TARGET_TOKEN_ADDRESS,
      buyToken: WETH_ADDRESS,
      sellAmount: targetTokenBalance.toString(),
      taker: botAddress,
      slippageBps: "500", // 5%
    });

    const quoteRes = await fetch(`https://api.0x.org/swap/v2/quote?${quoteParams.toString()}`, {
      headers: { 
        "0x-api-key": process.env.ZEROX_API_KEY!,
      },
    });

    const quote = await quoteRes.json();
    if (!quoteRes.ok) throw new Error(`0x V2 Error: ${quote.reason || "Unknown"}`);

    /**
     * LOGIKA SWAP V2 (AllowanceHolder):
     * Berdasarkan upgrade guide, kita harus memberikan approval ke alamat yang ditentukan 
     * di field `issues[].allowance.spender` atau jika menggunakan Permit2, 
     * approval dikirim ke Clearinghouse/Permit2 contract.
     */
    
    // Default spender untuk 0x v2 di Base biasanya adalah AllowanceHolder atau Clearinghouse
    const spender = quote.transaction.to; 

    console.log(`🚀 Executing Swap V2 via AllowanceHolder: ${spender}`);

    // 5. Eksekusi Batch via UserOperation (Gasless)
    const op = await smartAccount.sendUserOperation({
      calls: [
        // A. UNWRAP WETH -> ETH (Urutan pertama agar bot punya ETH untuk value di swap)
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({ 
            abi: ERC20_ABI, 
            functionName: "withdraw", 
            args: [wethBalance] 
          }),
        },
        // B. APPROVE Target Token ke 0x Spender
        {
          to: TARGET_TOKEN_ADDRESS,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [spender as Address, targetTokenBalance],
          }),
        },
        // C. EXECUTE SWAP (V2 transaction data)
        {
          to: quote.transaction.to as Address,
          data: quote.transaction.data as Hex,
          value: BigInt(quote.transaction.value),
        },
      ],
    });

    console.log("⏳ UserOp sent. Waiting for confirmation...");
    await op.wait();

    return NextResponse.json({ 
      success: true, 
      txHash: op.userOpHash,
      message: "Swap V2 executed successfully" 
    });

  } catch (error: any) {
    console.error("Swap-Flow V2 Error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
