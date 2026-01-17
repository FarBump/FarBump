import { NextRequest, NextResponse } from "next/server"
import { type Address, type Hex, encodeFunctionData, createPublicClient, http, hexToSignature, concatHex } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient, Wallet } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const
const WETH_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { botWalletAddresses, tokenAddress, recipientAddress } = body;

    const supabase = createSupabaseServiceClient();
    const results = [];

    for (const rawAddress of botWalletAddresses) {
      try {
        // 1. Ambil data bot dari database menggunakan smart_account_address
        const { data: bot, error: dbError } = await supabase
          .from("wallets_data")
          .select("id, owner_address, smart_account_address")
          .ilike("smart_account_address", rawAddress)
          .single();

        if (dbError || !bot) throw new Error(`Bot ${rawAddress} not found in database`);

        // 2. Inisialisasi Signer (CDP Server Wallet) menggunakan 'id' dari tabel
        // 'bot.id' di sini diasumsikan sebagai UUID wallet di CDP
        const ownerWallet = await Wallet.fetch(bot.id); 
        
        // 3. Inisialisasi Smart Account
        const smartAccount = await ownerWallet.getSmartAccount(bot.smart_account_address as Address);

        // 4. Cek Saldo & Cleanup Decimal
        const rawBalanceWei = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [bot.smart_account_address as Address],
        });
        const cleanBalanceWei = BigInt(rawBalanceWei.toString().split('.')[0]);

        if (cleanBalanceWei > 0n) {
          // 5. Fetch Quote dari 0x v2
          const query = new URLSearchParams({
            chainId: "8453",
            sellToken: (tokenAddress as string).toLowerCase(),
            buyToken: WETH_ADDRESS.toLowerCase(),
            sellAmount: cleanBalanceWei.toString(),
            taker: bot.smart_account_address.toLowerCase(),
          });

          const quoteRes = await fetch(`https://api.0x.org/gasless/quote?${query.toString()}`, {
            headers: { "0x-api-key": process.env.ZEROX_API_KEY || "", "0x-version": "v2" }
          });
          const quote = await quoteRes.json();
          if (!quoteRes.ok) throw new Error(quote.reason || "0x Quote Failed");

          // 6. Signature EIP-712 sesuai source 0x-examples
          const eip712 = quote.trade.eip712;
          const signatureHex = await ownerWallet.createPayloadSignature({
            domain: eip712.domain,
            types: eip712.types,
            primaryType: eip712.primaryType,
            message: eip712.message,
          });

          // Mengikuti logika Headless Example: r + s + v + signatureType(02)
          const sig = hexToSignature(signatureHex as Hex);
          const r = sig.r.padStart(66, '0x');
          const s = sig.s.padStart(66, '0x');
          const v = sig.v.toString(16).padStart(2, '0');
          const signatureType = "02"; // EIP712 Type
          
          const paddedSignature = `${r}${s.replace('0x','')}${v}${signatureType}` as Hex;
          const sigLengthHex = (paddedSignature.replace('0x','').length / 2).toString(16).padStart(64, '0');
          
          const finalCallData = `${quote.trade.transaction.data}${sigLengthHex}${paddedSignature.replace('0x','')}` as Hex;

          // 7. Execute via Smart Account
          const swapOp = await smartAccount.sendUserOperation({
            calls: [
              {
                to: tokenAddress as Address,
                data: encodeFunctionData({
                  abi: WETH_ABI,
                  functionName: "approve",
                  args: [quote.trade.clearinghouse as Address, cleanBalanceWei],
                }),
              },
              {
                to: quote.trade.transaction.to as Address,
                data: finalCallData,
              }
            ],
          });
          await swapOp.wait();
        }

        // 8. Transfer Akhir WETH ke Recipient
        const rawFinalWeth = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [bot.smart_account_address as Address],
        });
        const cleanFinalWeth = BigInt(rawFinalWeth.toString().split('.')[0]);

        if (cleanFinalWeth > 0n) {
          const transferOp = await smartAccount.sendUserOperation({
            calls: [{
              to: WETH_ADDRESS,
              data: encodeFunctionData({ 
                abi: WETH_ABI, 
                functionName: "transfer", 
                args: [recipientAddress as Address, cleanFinalWeth] 
              }),
            }],
          });
          await transferOp.wait();
        }

        results.push({ address: bot.smart_account_address, status: "success" });

      } catch (err: any) {
        console.error(`Error for ${rawAddress}:`, err.message);
        results.push({ address: rawAddress, status: "failed", error: err.message });
      }
    }
    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
