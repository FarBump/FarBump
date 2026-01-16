import { NextRequest, NextResponse } from "next/server"
import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
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
    const { botWalletAddresses, tokenAddress, recipientAddress } = await request.json()
    
    if (!botWalletAddresses || !tokenAddress || !recipientAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    const supabase = createSupabaseServiceClient()
    const cdp = new CdpClient()
    const results = []

    for (const address of botWalletAddresses) {
      try {
        const { data: bot } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", address)
          .single()

        if (!bot) continue

        const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({ 
          owner: ownerAccount, 
          address: address as Address 
        })

        // 1. Cek Saldo Token On-Chain
        const sellBalanceWei = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [address as Address],
        })

        if (sellBalanceWei > 0n) {
          // --- PERBAIKAN: Menggunakan standar URL modern & Header V2 ---
          const url = new URL("https://api.0x.org/gasless/quote")
          url.searchParams.append("chainId", "8453")
          url.searchParams.append("sellToken", tokenAddress.toLowerCase())
          url.searchParams.append("buyToken", WETH_ADDRESS.toLowerCase())
          url.searchParams.append("sellAmount", sellBalanceWei.toString())
          url.searchParams.append("taker", address.toLowerCase())

          const quoteRes = await fetch(url.toString(), {
            headers: { 
              "0x-api-key": process.env.ZEROX_API_KEY || "",
              "0x-version": "v2", // Wajib untuk /gasless
              "Accept": "application/json"
            }
          })
          
          // --- PERBAIKAN: Penanganan Error Non-JSON ---
          const contentType = quoteRes.headers.get("content-type")
          if (!quoteRes.ok || !contentType || !contentType.includes("application/json")) {
            const errorText = await quoteRes.text()
            throw new Error(`0x API Error (${quoteRes.status}): ${errorText}`)
          }
          
          const quote = await quoteRes.json()
          const allowanceTarget = quote.allowanceTarget as Address

          const calls = [
            {
              to: tokenAddress as Address,
              data: encodeFunctionData({
                abi: WETH_ABI,
                functionName: "approve",
                args: [allowanceTarget, sellBalanceWei],
              }),
              value: 0n
            },
            {
              to: quote.transaction.to as Address,
              data: quote.transaction.data as Hex,
              value: BigInt(quote.transaction.value || 0)
            }
          ]

          // Eksekusi Batch Swap via CDP Sponsored
          const swapOp = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: calls,
            isSponsored: true
          })
          await swapOp.wait()
        }

        // 2. Ambil Total WETH Akhir (Hasil swap + saldo sisa lama)
        const finalWethBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [address as Address],
        })

        // 3. Kirim SEMUA WETH ke Recipient
        if (finalWethBalance > 0n) {
          const transferData = encodeFunctionData({
            abi: WETH_ABI,
            functionName: "transfer",
            args: [recipientAddress as Address, finalWethBalance],
          })

          const transferOp = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: [{ to: WETH_ADDRESS, data: transferData, value: 0n }],
            isSponsored: true
          })
          await transferOp.wait()
        }

        // 4. Sinkronisasi Database
        await supabase.from("bot_wallet_credits").update({ weth_balance_wei: "0" }).eq("bot_wallet_address", address.toLowerCase())
        await supabase.from("wallets_data").update({ last_balance_update: new Date().toISOString() }).eq("smart_account_address", address)

        results.push({ address, status: "success", amount: finalWethBalance.toString() })

      } catch (err: any) {
        results.push({ address, status: "failed", error: err.message })
      }
    }

    return NextResponse.json({ success: true, details: results })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
