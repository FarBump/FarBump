import { NextRequest, NextResponse } from "next/server"
import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Constants
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

const WETH_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  }
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
        // 1. Ambil data bot dari DB
        const { data: bot } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", address)
          .single()

        if (!bot) {
          results.push({ address, status: "failed", error: "Wallet not found in DB" })
          continue
        }

        const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address })
        const smartAccount = await cdp.evm.getSmartAccount({ 
          owner: ownerAccount, 
          address: address as Address 
        })

        // 2. Cek saldo token yang akan di-swap secara on-chain
        const sellBalanceWei = await publicClient.readContract({
          address: tokenAddress as Address,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [address as Address],
        })

        // Jika saldo token > 0, lakukan SWAP ke WETH
        if (sellBalanceWei > 0n) {
          console.log(`🔄 Swapping ${sellBalanceWei.toString()} tokens for ${address}...`)
          
          const quoteParams = new URLSearchParams({
            chainId: "8453",
            sellToken: tokenAddress.toLowerCase(),
            buyToken: WETH_ADDRESS.toLowerCase(),
            sellAmount: sellBalanceWei.toString(),
            taker: address.toLowerCase(),
            slippageBps: "1000", // 10% untuk likuiditas tipis (Uniswap v4)
          })

          const quoteRes = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`, {
            headers: { 
              "0x-api-key": process.env.ZEROX_API_KEY!, 
              "0x-version": "v2" 
            }
          })
          
          if (!quoteRes.ok) throw new Error("Failed to get swap quote from 0x")
          const quote = await quoteRes.json()

          // Approval WETH ke 0x AllowanceHolder
          const allowanceTarget = quote.allowanceTarget || quote.transaction?.to
          const currentAllowance = await publicClient.readContract({
            address: tokenAddress as Address,
            abi: WETH_ABI,
            functionName: "allowance",
            args: [address as Address, allowanceTarget as Address],
          })

          if (currentAllowance < sellBalanceWei) {
            const approveData = encodeFunctionData({
              abi: WETH_ABI,
              functionName: "approve",
              args: [allowanceTarget as Address, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
            })
            const approveOp = await (smartAccount as any).sendUserOperation({
              calls: [{ to: tokenAddress as Address, data: approveData, value: 0n }],
              isSponsored: true
            })
            await approveOp.wait()
          }

          // Eksekusi Swap via Smart Account
          const swapOp = await (smartAccount as any).sendUserOperation({
            calls: [{ 
              to: quote.transaction.to as Address, 
              data: quote.transaction.data as Hex, 
              value: BigInt(quote.transaction.value || 0) 
            }],
            isSponsored: true
          })
          await swapOp.wait()
          console.log(`✅ Swap complete for ${address}`)
        }

        // 3. Ambil TOTAL SALDO WETH (Hasil swap + sisa saldo WETH sebelumnya)
        const totalWethBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [address as Address],
        })

        // 4. Kirim SEMUA WETH ke Recipient
        if (totalWethBalance > 0n) {
          console.log(`🚀 Sending total ${totalWethBalance.toString()} WETH to recipient...`)
          const transferData = encodeFunctionData({
            abi: WETH_ABI,
            functionName: "transfer",
            args: [recipientAddress as Address, totalWethBalance],
          })

          const transferOp = await (smartAccount as any).sendUserOperation({
            calls: [{ to: WETH_ADDRESS, data: transferData, value: 0n }],
            isSponsored: true
          })
          await transferOp.wait()
        }

        // 5. SINKRONISASI DATABASE (Penting agar tidak ada nilai sisa di UI)
        // Reset saldo kredit WETH di DB menjadi 0
        await supabase
          .from("bot_wallet_credits")
          .update({ weth_balance_wei: "0" })
          .eq("bot_wallet_address", address.toLowerCase())

        // Update timestamp pada wallets_data
        await supabase
          .from("wallets_data")
          .update({ last_balance_update: new Date().toISOString() })
          .eq("smart_account_address", address)

        results.push({ address, status: "success", amountWithdrawn: totalWethBalance.toString() })

      } catch (err: any) {
        console.error(`❌ Error with bot ${address}:`, err.message)
        results.push({ address, status: "failed", error: err.message })
      }
    }

    return NextResponse.json({ success: true, details: results })
  } catch (error: any) {
    console.error("❌ Withdraw API Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
