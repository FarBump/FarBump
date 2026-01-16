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
    const supabase = createSupabaseServiceClient()
    const cdp = new CdpClient()
    const results = []

    for (const address of botWalletAddresses) {
      try {
        const { data: bot } = await supabase.from("wallets_data").select("*").ilike("smart_account_address", address).single()
        if (!bot) continue

        const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: address as Address })

        const sellBalanceWei = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [address as Address],
        })

        if (sellBalanceWei > 0n) {
          const url = new URL("https://api.0x.org/gasless/quote")
          url.searchParams.append("chainId", "8453")
          url.searchParams.append("sellToken", tokenAddress.toLowerCase())
          url.searchParams.append("buyToken", WETH_ADDRESS.toLowerCase())
          url.searchParams.append("sellAmount", sellBalanceWei.toString())
          url.searchParams.append("taker", address.toLowerCase())

          const quoteRes = await fetch(url.toString(), {
            headers: { 
              "0x-api-key": process.env.ZEROX_API_KEY || "", 
              "0x-version": "v2" 
            }
          })
          
          const quote = await quoteRes.json()

          // 1. Ambil Spender (Permit2)
          const spender = quote.issues?.allowance?.spender || quote.allowanceTarget

          // 2. Buat Signature untuk Permit2 (EIP-712)
          // Berdasarkan log Anda, data ada di quote.trade.eip712
          const eip712Data = quote.trade?.eip712
          if (!eip712Data) throw new Error("No EIP712 data found in quote")

          const signature = await (smartAccount as any).signTypedData(eip712Data)

          // 3. Gabungkan Signature ke Data Transaksi (Mekanisme Settler 0x)
          // Format Settler: [Original Data] + [Signature Length (32 bytes)] + [Signature]
          const sigLengthHex = (signature.length / 2 - 1).toString(16).padStart(64, '0')
          const finalData = (quote.trade.transaction?.data || quote.transaction?.data) + sigLengthHex + signature.replace('0x', '')

          const calls = [
            {
              to: tokenAddress as Address,
              data: encodeFunctionData({
                abi: WETH_ABI,
                functionName: "approve",
                args: [spender as Address, sellBalanceWei],
              }),
              value: 0n
            },
            {
              to: quote.target as Address, // Alamat target Settler dari log
              data: finalData as Hex,
              value: 0n
            }
          ]

          const swapOp = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls,
            isSponsored: true
          })
          await swapOp.wait()
        }

        // --- Proses Withdraw WETH Akhir ---
        const finalBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [address as Address],
        })

        if (finalBalance > 0n) {
          const transferOp = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: [{
              to: WETH_ADDRESS,
              data: encodeFunctionData({ abi: WETH_ABI, functionName: "transfer", args: [recipientAddress as Address, finalBalance] }),
              value: 0n
            }],
            isSponsored: true
          })
          await transferOp.wait()
        }

        await supabase.from("bot_wallet_credits").update({ weth_balance_wei: "0" }).eq("bot_wallet_address", address.toLowerCase())
        results.push({ address, status: "success" })

      } catch (err: any) {
        results.push({ address, status: "failed", error: err.message })
      }
    }
    return NextResponse.json({ success: true, details: results })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
