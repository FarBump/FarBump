import { NextRequest, NextResponse } from "next/server"
import { type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const ERC20_ABI = [
  { constant: true, inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "balance", type: "uint256" }], type: "function" },
  { constant: false, inputs: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], type: "function" },
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

export async function POST(request: NextRequest) {
  try {
    const apiKeyName = process.env.CDP_API_KEY_ID;
    const privateKey = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n");

    if (!apiKeyName || !privateKey) {
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }

    const body = await request.json()
    // SEKARANG MENERIMA ARRAY botWalletAddresses
    const { botWalletAddresses, tokenAddress, recipientAddress, symbol } = body

    if (!Array.isArray(botWalletAddresses) || botWalletAddresses.length === 0 || !tokenAddress || !recipientAddress) {
      return NextResponse.json({ error: "Missing required fields or bot list" }, { status: 400 })
    }

    const supabase = createSupabaseServiceClient()
    const cdp = new CdpClient({ apiKeyName, privateKey });
    const results = [];

    // LOOPING UNTUK MEMPROSES SEMUA BOT (5 BOT)
    for (const address of botWalletAddresses) {
      try {
        // 1. Ambil data per bot
        const { data: botWallet } = await supabase
          .from("wallets_data")
          .select("smart_account_address, owner_address")
          .ilike("smart_account_address", address)
          .single()

        if (!botWallet) {
          results.push({ address, status: "error", message: "Wallet not found" });
          continue;
        }

        // 2. Cek Saldo Max
        const currentBalance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [botWallet.smart_account_address as Address],
        });

        if (BigInt(currentBalance) === 0n) {
          results.push({ address, status: "skipped", message: "Zero balance" });
          continue;
        }

        // 3. Inisialisasi Smart Account CDP
        const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({
          owner: ownerAccount,
          address: botWallet.smart_account_address as Address,
        })

        // 4. Kirim Gasless
        const transferData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [recipientAddress as Address, currentBalance],
        })

        const userOpHash = await (smartAccount as any).sendUserOperation({
          network: "base",
          calls: [{ to: tokenAddress as Address, data: transferData as Hex, value: 0n }],
          isSponsored: true,
        })

        results.push({ address, status: "success", hash: userOpHash });

      } catch (err: any) {
        results.push({ address, status: "failed", error: err.message });
      }
    }

    return NextResponse.json({
      success: true,
      processed: results.length,
      details: results
    })

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
