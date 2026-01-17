import { NextRequest, NextResponse } from "next/server"
import { type Address, type Hex, encodeFunctionData, createPublicClient, http, hexToSignature } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
// Gunakan CdpClient sesuai pola yang sudah bekerja di kode Anda
import { CdpClient } from "@coinbase/cdp-sdk"

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

    // Inisialisasi CdpClient (Pola V2)
    const cdp = new CdpClient();

    for (const botAddress of botWalletAddresses) {
      try {
        // 1. Ambil data dari wallets_data
        const { data: botWallet } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", botAddress)
          .single();

        if (!botWallet) {
          results.push({ address: botAddress, status: "error", message: "Wallet not found" });
          continue;
        }

        // 2. Cek saldo token (WETH atau Token lain)
        const balance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [botWallet.smart_account_address as Address],
        });

        if (balance === 0n) {
          results.push({ address: botAddress, status: "skipped", message: "Zero balance" });
          continue;
        }

        // 3. Inisialisasi Akun (Menggunakan Alamat 0x, bukan UUID)
        const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({
          owner: ownerAccount,
          address: botWallet.smart_account_address as Address,
        });

        // 4. Proses 0x Quote & Swap
        const query = new URLSearchParams({
          chainId: "8453",
          sellToken: (tokenAddress as string).toLowerCase(),
          buyToken: WETH_ADDRESS.toLowerCase(),
          sellAmount: balance.toString(),
          taker: botWallet.smart_account_address.toLowerCase(),
        });

        const quoteRes = await fetch(`https://api.0x.org/gasless/quote?${query.toString()}`, {
          headers: { "0x-api-key": process.env.ZEROX_API_KEY || "", "0x-version": "v2" }
        });
        const quote = await quoteRes.json();
        
        if (!quoteRes.ok) throw new Error(quote.reason || "0x Quote Failed");

        // 5. Signing via CdpClient (Smart Account V2)
        const eip712 = quote.trade.eip712;
        // Catatan: Pastikan method signing pada smartAccount V2 sesuai dengan dokumentasi terupdate
        const signatureHex = await smartAccount.signTypedData(eip712.domain, eip712.types, eip712.message);

        const sig = hexToSignature(signatureHex as Hex);
        const r = sig.r.padStart(66, '0x');
        const s = sig.s.padStart(66, '0x');
        const v = sig.v.toString(16).padStart(2, '0');
        const finalCallData = `${quote.trade.transaction.data}${( (r + s.replace('0x','') + v + "02").replace('0x','').length / 2 ).toString(16).padStart(64, '0')}${r.replace('0x','')}${s.replace('0x','')}${v}02` as Hex;

        // 6. Execute UserOp
        const swapOp = await smartAccount.sendUserOperation({
          calls: [
            {
              to: tokenAddress as Address,
              data: encodeFunctionData({
                abi: WETH_ABI,
                functionName: "approve",
                args: [quote.trade.clearinghouse as Address, balance],
              }),
            },
            {
              to: quote.trade.transaction.to as Address,
              data: finalCallData,
            }
          ],
        });
        
        await swapOp.wait();
        results.push({ address: botAddress, status: "success" });

      } catch (err: any) {
        results.push({ address: botAddress, status: "failed", error: err.message });
      }
    }

    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
