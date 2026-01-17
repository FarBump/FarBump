import { NextRequest, NextResponse } from "next/server";
import { 
  type Address, 
  type Hex, 
  encodeFunctionData, 
  createPublicClient, 
  http, 
  hexToSignature 
} from "viem";
import { base } from "viem/chains";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createSupabaseServiceClient } from "@/lib/supabase";

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

    // 1. Ambil data wallet
    const { data: botWallet } = await supabase
      .from("wallets_data")
      .select("*")
      .ilike("smart_account_address", botAddress)
      .single();

    if (!botWallet) throw new Error("Wallet not found in database");

    // 2. Inisialisasi CDP
    const cdp = new CdpClient();
    const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address });
    const smartAccount = await cdp.evm.getSmartAccount({ 
      owner: ownerAccount, 
      address: botAddress as Address 
    });

    const publicClient = createPublicClient({ chain: base, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });

    // 3. Cek Saldo
    const [wethBalance, targetTokenBalance] = await Promise.all([
      publicClient.readContract({ address: WETH_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
      publicClient.readContract({ address: TARGET_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [botAddress as Address] }),
    ]);

    // 4. Get 0x Gasless Quote (V2)
    const quoteParams = new URLSearchParams({
      chainId: "8453",
      sellToken: TARGET_TOKEN_ADDRESS,
      buyToken: WETH_ADDRESS,
      sellAmount: targetTokenBalance.toString(),
      taker: botAddress,
      slippageBps: "1000", // 10% untuk token baru
    });

    const quoteRes = await fetch(`https://api.0x.org/gasless/quote?${quoteParams.toString()}`, {
      headers: { 
        "0x-api-key": process.env.ZEROX_API_KEY!,
        "0x-version": "v2" 
      },
    });

    const quote = await quoteRes.json();
    if (!quoteRes.ok) throw new Error(`0x Error: ${quote.reason || "Unknown"}`);

    // 5. SIGN EIP-712 (Sesuai Upgrading to Gasless V2 Docs)
    const eip712 = quote.trade.eip712;
    const signatureHex = await smartAccount.signTypedData(
      eip712.domain,
      eip712.types,
      eip712.message
    );

    // Format Signature (r + s + v + signatureType)
    const sig = hexToSignature(signatureHex as Hex);
    const r = sig.r.padStart(66, "0x");
    const s = sig.s.padStart(66, "0x");
    const v = sig.v.toString(16).padStart(2, "0");
    const signatureType = "02"; // Standard Signature Type
    
    const paddedSignature = `${r}${s.replace("0x", "")}${v}${signatureType}` as Hex;
    const sigLengthHex = (paddedSignature.replace("0x", "").length / 2).toString(16).padStart(64, "0");
    
    // Gabungkan Transaction Data + Signature Length + Padded Signature
    const finalCallData = `${quote.trade.transaction.data}${sigLengthHex}${paddedSignature.replace("0x", "")}` as Hex;

    // 6. Execute Batch via CDP Paymaster
    const op = await smartAccount.sendUserOperation({
      calls: [
        // A. Unwrap WETH sisa (Gasless)
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({ 
            abi: ERC20_ABI, 
            functionName: "withdraw", 
            args: [wethBalance] 
          }),
        },
        // B. Approve Token ke 0x Clearinghouse
        {
          to: TARGET_TOKEN_ADDRESS,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [quote.trade.clearinghouse as Address, targetTokenBalance],
          }),
        },
        // C. Execute Gasless Swap V2
        {
          to: quote.trade.transaction.to as Address,
          data: finalCallData,
        },
      ],
    });

    await op.wait();

    return NextResponse.json({ 
      success: true, 
      txHash: op.userOpHash,
      message: "Gasless Unwrap & Gasless Swap executed" 
    });

  } catch (error: any) {
    console.error("Swap-Flow Error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
