import { NextRequest, NextResponse } from "next/server"
import { formatEther, type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// ERC20 ABI untuk transfer dan balance
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
    const body = await request.json()
    // Kita terima array botWalletAddresses agar bisa sekaligus
    const { botWalletAddresses, tokenAddress, recipientAddress, symbol } = body

    if (!botWalletAddresses || !Array.isArray(botWalletAddresses) || !tokenAddress || !recipientAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    const supabase = createSupabaseServiceClient()
    
    // Inisialisasi CDP (mengikuti pola execute-swap)
    const apiKeyId = process.env.CDP_API_KEY_ID
    const apiKeySecret = process.env.CDP_API_KEY_SECRET
    if (!apiKeyId || !apiKeySecret) {
      return NextResponse.json({ error: "CDP credentials missing" }, { status: 500 })
    }
    const cdp = new CdpClient()

    const results = []

    // Loop untuk memproses 5 bot sekaligus
    for (const botAddress of botWalletAddresses) {
      try {
        console.log(`🤖 [Send Token] Processing bot: ${botAddress}`)

        // 1. Ambil data owner dari wallets_data
        const { data: botWallet } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", botAddress)
          .single()

        if (!botWallet) {
          results.push({ address: botAddress, status: "error", message: "Wallet not found" })
          continue
        }

        // 2. Cek saldo on-chain (untuk mendapatkan MAX amount)
        const balance = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [botWallet.smart_account_address as Address],
        })

        if (balance === 0n) {
          results.push({ address: botAddress, status: "skipped", message: "Zero balance" })
          continue
        }

        // 3. Inisialisasi Smart Account (pola CDP V2)
        const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({
          owner: ownerAccount,
          address: botWallet.smart_account_address as Address,
        })

        // 4. Encode Transfer
        const transferData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [recipientAddress as Address, balance],
        })

        // 5. Kirim UserOperation (Gasless/Sponsored)
        const userOpHash = await (smartAccount as any).sendUserOperation({
          network: "base",
          calls: [{ to: tokenAddress as Address, data: transferData as Hex, value: 0n }],
          isSponsored: true,
        })

        // Ambil hash string
        const txHash = typeof userOpHash === 'string' ? userOpHash : (userOpHash.hash || String(userOpHash))

        // 6. UPDATE DATABASE (Sync jumlah token)
        // Jika yang dikirim adalah BUMP (token target), kita update recordnya
        // Catatan: Anda mungkin perlu menyesuaikan nama kolom saldo di tabel Anda
        await supabase
          .from("bot_wallet_credits") // Mengikuti tabel di swap-route Anda
          .update({ 
            // Jika ini pengiriman token target, biasanya saldo di DB perlu di-nol-kan
            // karena kita mengirimkan "balance" (MAX)
            updated_at: new Date().toISOString()
          })
          .eq("bot_wallet_address", botAddress.toLowerCase())

        // Opsional: Log ke bot_logs
        await supabase.from("bot_logs").insert({
          user_address: botWallet.user_address,
          wallet_address: botAddress,
          token_address: tokenAddress,
          amount_wei: balance.toString(),
          action: "token_sent",
          message: `Sent ${formatEther(balance)} ${symbol} to ${recipientAddress}`,
          status: "success"
        })

        results.push({ address: botAddress, status: "success", txHash })

      } catch (err: any) {
        console.error(`❌ Error on bot ${botAddress}:`, err.message)
        results.push({ address: botAddress, status: "failed", error: err.message })
      }
    }

    return NextResponse.json({ success: true, details: results })

  } catch (error: any) {
    console.error("❌ Global Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
