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
    const body = await request.json()
    const { botWalletAddresses, tokenAddress, recipientAddress } = body
    
    // Validasi input awal (Defensive)
    if (!botWalletAddresses || !tokenAddress || !recipientAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    const supabase = createSupabaseServiceClient()
    const cdp = new CdpClient()
    const results = []

    for (const address of botWalletAddresses) {
      try {
        // Pastikan address & tokenAddress adalah string sebelum manipulasi
        const safeAddress = String(address || "").trim()
        const safeToken = String(tokenAddress || "").trim()

        if (!safeAddress || !safeToken) {
          throw new Error("Invalid address or tokenAddress data type")
        }

        const { data: bot } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", safeAddress)
          .single()

        if (!bot) continue

        const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: safeAddress as Address })

        const sellBalanceWei = await publicClient.readContract({
          address: safeToken as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [safeAddress as Address],
        })

        if (sellBalanceWei > 0n) {
          // --- PERBAIKAN URL: Menggunakan WHATWG URL API Secara Penuh ---
          const zeroxUrl = new URL("https://api.0x.org/gasless/quote")
          zeroxUrl.searchParams.set("chainId", "8453")
          zeroxUrl.searchParams.set("sellToken", safeToken.toLowerCase())
          zeroxUrl.searchParams.set("buyToken", WETH_ADDRESS.toLowerCase())
          zeroxUrl.searchParams.set("sellAmount", sellBalanceWei.toString())
          zeroxUrl.searchParams.set("taker", safeAddress.toLowerCase())

          const quoteRes = await fetch(zeroxUrl.toString(), {
            headers: { 
              "0x-api-key": process.env.ZEROX_API_KEY || "", 
              "0x-version": "v2",
              "Accept": "application/json"
            }
          })
          
          const quote = await quoteRes.json()

          // Akses properti v2 yang dinamis
          const spender = quote.issues?.allowance?.spender || quote.allowanceTarget
          const eip712Data = quote.trade?.eip712
          
          if (!eip712Data) throw new Error("No EIP712 data found in 0x quote")

          const signature = await (smartAccount as any).signTypedData(eip712Data)

          const sigLengthHex = (signature.length / 2 - 1).toString(16).padStart(64, '0')
          const baseData = quote.trade.transaction?.data || quote.transaction?.data || ""
          const finalData = (baseData + sigLengthHex + signature.replace('0x', '')) as Hex

          const calls = [
            {
              to: safeToken as Address,
              data: encodeFunctionData({
                abi: WETH_ABI,
                functionName: "approve",
                args: [spender as Address, sellBalanceWei],
              }),
              value: 0n
            },
            {
              to: (quote.target || quote.transaction?.to) as Address,
              data: finalData,
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

        // Sisa transfer WETH
        const finalBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [safeAddress as Address],
        })

        if (finalBalance > 0n) {
          const transferOp = await (smartAccount as any).sendUserOperation({
            network: "base",
            calls: [{
              to: WETH_ADDRESS,
              data: encodeFunctionData({ 
                abi: WETH_ABI, 
                functionName: "transfer", 
                args: [recipientAddress as Address, finalBalance] 
              }),
              value: 0n
            }],
            isSponsored: true
          })
          await transferOp.wait()
        }

        await supabase.from("bot_wallet_credits").update({ weth_balance_wei: "0" }).eq("bot_wallet_address", safeAddress.toLowerCase())
        results.push({ address: safeAddress, status: "success" })

      } catch (err: any) {
        results.push({ address: address || "unknown", status: "failed", error: err.message })
      }
    }
    return NextResponse.json({ success: true, details: results })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
