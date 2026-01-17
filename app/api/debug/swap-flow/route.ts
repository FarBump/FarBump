import { NextRequest, NextResponse } from "next/server";
import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createSupabaseServiceClient } from "@/lib/supabase";

// Constants
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
const TARGET_TOKEN_ADDRESS = "0x8984B389cB82e05016DB2E4c7230ca0791b9Cb07" as const; // Token target Anda

const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], type: "function", stateMutability: "view" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], type: "function", stateMutability: "nonpayable" },
  { inputs: [{ name: "wad", type: "uint256" }], name: "withdraw", outputs: [], type: "function", stateMutability: "nonpayable" },
] as const;

export async function POST(req: NextRequest) {
  try {
    const { botAddress } = await req.json();
    const supabase = createSupabaseServiceClient();

    // 1. Ambil data wallet dari database Supabase
    const { data: botWallet } = await supabase
      .from("wallets_data")
      .select("*")
      .ilike("smart_account_address", botAddress)
      .single();

    if (!botWallet) {
      return NextResponse.json({ success: false, error: "Wallet not found in database" }, { status: 404 });
    }

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

    // 3. Cek Saldo WETH (untuk gas) dan Saldo Token Target (untuk swap)
    const [wethBalance, targetTokenBalance] = await Promise.all([
      publicClient.readContract({ 
        address: WETH_ADDRESS, 
        abi: ERC20_ABI, 
        functionName: "balanceOf", 
        args: [botAddress as Address] 
      }),
      publicClient.readContract({ 
        address: TARGET_TOKEN_ADDRESS, 
        abi: ERC20_ABI, 
        functionName: "balanceOf", 
        args: [botAddress as Address] 
      }),
    ]);

    if (targetTokenBalance === 0n) {
      return NextResponse.json({ success: false, error: "Target token balance is zero" }, { status: 400 });
    }

    // 4. Ambil Quote dari 0x API v2 (Swap Target Token -> WETH)
    const quoteParams = new URLSearchParams({
      chain: "base",
      sellToken: TARGET_TOKEN_ADDRESS,
      buyToken: WETH_ADDRESS,
      sellAmount: targetTokenBalance.toString(),
      taker: botAddress,
      slippageBps: "500", // 5% slippage
    });

    const quoteRes = await fetch(`https://api.0x.org/swap/v2/quote?${quoteParams.toString()}`, {
      headers: { 
        "0x-api-key": process.env.ZEROX_API_KEY!,
        "0x-version": "v2" 
      },
    });

    const quote = await quoteRes.json();
    if (!quoteRes.ok) throw new Error(quote.reason || "0x Quote Error");

    console.log(`🔄 Executing Swap for Token: ${TARGET_TOKEN_ADDRESS}`);

    // 5. Batch Operation:
    // A. Unwrap WETH sisa menjadi ETH (Gasless via Paymaster) -> Biar ada saldo untuk gas 0x
    // B. Approve 0x untuk memindahkan Target Token
    // C. Eksekusi Swap via 0x
    const op = await smartAccount.sendUserOperation({
      calls: [
        // A. Unwrap WETH ke ETH (Jika ada saldo WETH)
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({ 
            abi: ERC20_ABI, 
            functionName: "withdraw", 
            args: [wethBalance] 
          }),
        },
        // B. Approve Target Token ke 0x Clearinghouse
        {
          to: TARGET_TOKEN_ADDRESS,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [quote.transaction.to as Address, targetTokenBalance],
          }),
        },
        // C. Swap Target Token ke WETH
        {
          to: quote.transaction.to as Address,
          data: quote.transaction.data as Hex,
          value: BigInt(quote.transaction.value),
        },
      ],
    });

    console.log("⏳ Waiting for transaction confirmation...");
    await op.wait();

    return NextResponse.json({ 
      success: true, 
      txHash: op.userOpHash,
      message: "Unwrap & Swap completed successfully" 
    });

  } catch (error: any) {
    console.error("Debug Swap Error:", error.message);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}
