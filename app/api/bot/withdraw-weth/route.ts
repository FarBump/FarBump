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
    
    // 1. Validasi Input Dasar
    if (!botWalletAddresses || !Array.isArray(botWalletAddresses)) {
      return NextResponse.json({ error: "botWalletAddresses must be an array" }, { status: 400 })
    }

    if (!tokenAddress || typeof tokenAddress !== 'string') {
      return NextResponse.json({ error: "tokenAddress is required and must be a string" }, { status: 400 })
    }

    const supabase = createSupabaseServiceClient()
    const cdp = new CdpClient()
    const results = []

    // Cache string yang sering digunakan untuk menghindari pemanggilan berulang
    const sellTokenSafe = tokenAddress.trim().toLowerCase()
    const buyTokenSafe = WETH_ADDRESS.toLowerCase()

    for (const address of botWalletAddresses) {
      try {
        // 2. Proteksi Loop: Pastikan alamat wallet ada dan valid
        if (!address || typeof address !== 'string') {
          results.push({ address: "invalid", status: "failed", error: "Wallet address is missing or not a string" })
          continue
        }

        const currentWalletAddr = address.trim()
        const currentWalletLower = currentWalletAddr.toLowerCase()

        const { data: bot } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", currentWalletAddr)
          .single()

        if (!bot) {
          results.push({ address: currentWalletAddr, status: "failed", error: "Wallet not found in database" })
          continue
        }

        const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: currentWalletAddr as Address })

        const sellBalanceWei = await publicClient.readContract({
          address: sellTokenSafe as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [currentWalletAddr as Address],
        })

        if (sellBalanceWei > 0n) {
          const url = new URL("https://api.0x.org/gasless/quote")
          url.searchParams.append("chainId", "8453")
          url.searchParams.append("sellToken", sellTokenSafe)
          url.searchParams.append("buyToken", buyTokenSafe)
          url.searchParams.append("sellAmount", sellBalanceWei.toString())
          url.searchParams.append("taker", currentWalletLower)

          const quoteRes = await fetch(url.toString(), {
            headers: { 
              "0x-api-key": process.env.ZEROX_API_KEY || "", 
              "0x-version": "v2" 
            }
          })
          
          if (!quoteRes.ok) {
            const errData = await quoteRes.text()
            throw new Error(`0x API Error: ${errData}`)
          }

          const quote = await quoteRes.json()

          const spender = quote.issues?.allowance?.spender || quote.allowanceTarget
          const eip712Data = quote.trade?.eip712
          
          if (!eip712Data) throw new Error("No EIP712 data found in quote")

          // Sign message EIP-712
          const signature = await (smartAccount as any).signTypedData(eip712Data)

          // Append signature ke data transaksi Settler
          const sigLengthHex = (signature.length / 2 - 1).toString(16).padStart(64, '0')
          const baseData = quote.trade.transaction?.data || quote.transaction?.data || ""
          const finalData = (baseData + sigLengthHex + signature.replace('0x', '')) as Hex

          const calls = [
            {
              to: sellTokenSafe as Address,
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
          
          // Beri waktu sejenak agar state blockchain terupdate di RPC
          await new Promise(r => setTimeout(r, 1000))
        }

        // Withdraw WETH sisa
        const finalBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [currentWalletAddr as Address],
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

        await supabase.from("bot_wallet_credits").update({ weth_balance_wei: "0" }).eq("bot_wallet_address", currentWalletLower)
        results.push({ address: currentWalletAddr, status: "success" })

      } catch (err: any) {
        results.push({ address: address || "unknown", status: "failed", error: err.message })
      }
    }
    return NextResponse.json({ success: true, details: results })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
