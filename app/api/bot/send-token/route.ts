import { NextRequest, NextResponse } from "next/server"
import { formatEther, type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

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
        // CRITICAL: Jika yang dikirim adalah WETH, kurangi weth_balance_wei di database
        // Ini memastikan credit balance sinkron dengan on-chain balance
        const isWeth = tokenAddress.toLowerCase() === WETH_ADDRESS.toLowerCase()
        
        if (isWeth) {
          console.log(`   💰 Updating WETH credit balance for bot wallet...`)
          
          // Fetch current credit record
          const { data: creditRecord, error: fetchError } = await supabase
            .from("bot_wallet_credits")
            .select("id, weth_balance_wei")
            .eq("bot_wallet_address", botAddress.toLowerCase())
            .single()

          if (!fetchError && creditRecord) {
            const currentBalance = BigInt(creditRecord.weth_balance_wei || "0")
            const sentAmount = balance // amount yang dikirim
            
            if (currentBalance >= sentAmount) {
              // Deduct sent amount from bot wallet credit
              const newBalance = currentBalance - sentAmount
              
              const { error: updateError } = await supabase
                .from("bot_wallet_credits")
                .update({ 
                  weth_balance_wei: newBalance.toString(),
                  updated_at: new Date().toISOString()
                })
                .eq("id", creditRecord.id)
              
              if (updateError) {
                console.error(`   ❌ Error updating WETH balance:`, updateError)
              } else {
                console.log(`   ✅ WETH balance deducted: ${formatEther(sentAmount)} WETH`)
                console.log(`   → Remaining balance: ${formatEther(newBalance)} WETH`)
                console.log(`   → Credit balance updated correctly after send`)
              }
            } else {
              console.warn(`   ⚠️ Insufficient WETH balance in DB: ${formatEther(currentBalance)} < ${formatEther(sentAmount)}`)
              // Set to 0 if insufficient (all credit consumed)
              await supabase
                .from("bot_wallet_credits")
                .update({ 
                  weth_balance_wei: "0",
                  updated_at: new Date().toISOString()
                })
                .eq("id", creditRecord.id)
              console.log(`   → Bot wallet credit set to 0 (all consumed)`)
            }
          } else {
            console.warn(`   ⚠️ No credit record found for bot wallet`)
            console.warn(`   → WETH sent but credit balance not updated (record missing)`)
          }
        } else {
          // For non-WETH tokens, just update timestamp
          await supabase
            .from("bot_wallet_credits")
            .update({ 
              updated_at: new Date().toISOString()
            })
            .eq("bot_wallet_address", botAddress.toLowerCase())
        }

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
