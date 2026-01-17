import { NextRequest, NextResponse } from "next/server"
import { formatEther, type Address, type Hex, createPublicClient, http, encodeFunctionData, hexToSignature } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Constants
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    // 'tokenAddress' berasal dari Select Token di Manage Bot
    const { smart_account_address, tokenAddress } = body as { 
      smart_account_address: string[], 
      tokenAddress: string 
    }

    if (!smart_account_address || !tokenAddress) {
      return NextResponse.json({ error: "Missing smart_account_address or tokenAddress" }, { status: 400 })
    }

    const supabase = createSupabaseServiceClient()
    const cdp = new CdpClient() // V2 Client
    const results = []

    console.log(`🔄 Starting Swap to WETH for Token: ${tokenAddress}`)

    for (const botAddress of smart_account_address) {
      try {
        // 1. Fetch data wallet dari database
        const { data: botWallet } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", botAddress)
          .single()

        if (!botWallet) {
          results.push({ address: botAddress, status: "error", message: "Wallet not found" })
          continue
        }

        // 2. Cek Saldo Token yang dipilih (On-chain)
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

        // 3. Inisialisasi Smart Account CDP V2
        const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({
          owner: ownerAccount,
          address: botWallet.smart_account_address as Address,
        })

        // 4. Get 0x API v2 Quote (Optimized for Thin Liquidity)
        const params = new URLSearchParams({
          chainId: "8453",
          sellToken: tokenAddress.toLowerCase(),
          buyToken: WETH_ADDRESS.toLowerCase(),
          sellAmount: balance.toString(),
          taker: smart_account_address.toLowerCase(),
          slippageBps: attempt === 1 ? "500" : "1000", // 5% = 500 bps, 10% = 1000 bps
          skipValidation: "true",
          enableSlippageProtection: "false"
        })

        const quoteRes = await fetch(`https://api.0x.org/gasless/quote?${params.toString()}`, {
          headers: { 
            "0x-api-key": process.env.ZEROX_API_KEY || "", 
            "0x-version": "v2" 
          }
        })

        const quote = await quoteRes.json()
        if (!quoteRes.ok) throw new Error(quote.reason || "0x Quote Failed")

        // 5. Signing EIP-712 via CDP V2
        const eip712 = quote.trade.eip712
        const signatureHex = await smartAccount.signTypedData(
          eip712.domain,
          eip712.types,
          eip712.message
        )

        // Format signature untuk 0x v2 (r + s + v + signatureType)
        const sig = hexToSignature(signatureHex as Hex)
        const r = sig.r.padStart(66, '0x')
        const s = sig.s.padStart(66, '0x')
        const v = sig.v.toString(16).padStart(2, '0')
        const signatureType = "02" 
        
        const paddedSignature = `${r}${s.replace('0x','')}${v}${signatureType}` as Hex
        const sigLengthHex = (paddedSignature.replace('0x','').length / 2).toString(16).padStart(64, '0')
        const finalCallData = `${quote.trade.transaction.data}${sigLengthHex}${paddedSignature.replace('0x','')}` as Hex

        // 6. Execute Batch Operation
        const swapOp = await smartAccount.sendUserOperation({
          calls: [
            {
              to: tokenAddress as Address,
              data: encodeFunctionData({
                abi: ERC20_ABI,
                functionName: "approve",
                args: [quote.trade.clearinghouse as Address, balance],
              }),
            },
            {
              to: quote.trade.transaction.to as Address,
              data: finalCallData,
            }
          ],
        })

        await swapOp.wait()
        results.push({ address: botAddress, status: "success", txHash: swapOp.userOpHash })
        console.log(`✅ Success swap for ${botAddress}`)

      } catch (err: any) {
        console.error(`❌ Error for ${botAddress}:`, err.message)
        results.push({ address: botAddress, status: "failed", error: err.message })
      }
    }

    return NextResponse.json({ success: true, details: results })

  } catch (error: any) {
    console.error("Critical Error:", error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
