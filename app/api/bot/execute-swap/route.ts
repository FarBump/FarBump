import { NextRequest, NextResponse } from "next/server"
import { formatEther, parseEther, type Address } from "viem"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Constants
const MIN_AMOUNT_USD = 0.01

// 0x Protocol Router (for swap quotes)
const ZEROX_ROUTER = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF"

/**
 * API Route: Execute Swap for Bot Wallet using CDP Server Wallets V2
 * 
 * This route:
 * 1. Fetches bot wallet from CDP using wallet ID
 * 2. Checks balance (must be >= MIN_AMOUNT_USD)
 * 3. Gets swap quote from 0x API
 * 4. Executes swap using wallet.invokeContract (gasless via CDP)
 * 5. Updates wallet rotation index for round-robin
 * 6. Logs all activities
 * 
 * Benefits:
 * - Native gas sponsorship (no Paymaster allowlist issues)
 * - CDP manages all signing securely
 * - No manual viem signing or User Operations
 * - Simpler and more reliable
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { sessionId, walletIndex } = body as { sessionId: string; walletIndex: number }

    if (!sessionId || walletIndex === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: sessionId, walletIndex" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Step 1: Fetch active bot session
    console.log(`🤖 [Bot Swap] Fetching session ${sessionId}...`)
    
    const { data: session, error: sessionError } = await supabase
      .from("bot_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("status", "active")
      .single()

    if (sessionError || !session) {
      console.error("❌ Session not found or inactive:", sessionError)
      return NextResponse.json(
        { error: "Session not found or inactive" },
        { status: 404 }
      )
    }

    const { user_address, token_address, amount_usd, wallet_rotation_index } = session

    console.log(`✅ Session found:`)
    console.log(`   User: ${user_address}`)
    console.log(`   Token: ${token_address}`)
    console.log(`   Amount: $${amount_usd}`)
    console.log(`   Current rotation index: ${wallet_rotation_index}`)

    // Step 2: Fetch bot wallets for this user
    const { data: botWallets, error: walletsError } = await supabase
      .from("wallets_data")
      .select("*")
      .eq("user_address", user_address.toLowerCase())
      .order("created_at", { ascending: true })

    if (walletsError || !botWallets || botWallets.length !== 5) {
      console.error("❌ Failed to fetch bot wallets:", walletsError)
      return NextResponse.json(
        { error: "Bot wallets not found or incomplete" },
        { status: 404 }
      )
    }

    // Step 3: Select bot wallet based on rotation index
    const botWallet = botWallets[walletIndex]
    
    if (!botWallet) {
      console.error(`❌ Bot wallet at index ${walletIndex} not found`)
      return NextResponse.json(
        { error: `Bot wallet at index ${walletIndex} not found` },
        { status: 404 }
      )
    }

    console.log(`🤖 Selected Bot #${walletIndex + 1}:`)
    console.log(`   CDP Wallet ID: ${botWallet.coinbase_wallet_id}`)
    console.log(`   Address: ${botWallet.smart_account_address}`)

    // Step 4: Initialize CDP SDK
    console.log("🔧 Initializing Coinbase CDP SDK...")
    
    const cdpApiKeyName = process.env.CDP_API_KEY_NAME
    const cdpPrivateKey = process.env.CDP_PRIVATE_KEY

    if (!cdpApiKeyName || !cdpPrivateKey) {
      console.error("❌ Missing CDP credentials")
      return NextResponse.json(
        { error: "CDP credentials not configured" },
        { status: 500 }
      )
    }

    Coinbase.configure({
      apiKeyName: cdpApiKeyName,
      privateKey: cdpPrivateKey,
    })

    // Step 5: Fetch wallet from CDP
    console.log(`📥 Fetching wallet from CDP...`)
    
    const wallet = await Wallet.fetch(botWallet.coinbase_wallet_id)
    
    if (!wallet) {
      console.error("❌ Failed to fetch wallet from CDP")
      return NextResponse.json(
        { error: "Failed to fetch wallet from CDP" },
        { status: 500 }
      )
    }

    console.log(`✅ Wallet fetched successfully`)

    // Step 6: Check balance
    console.log(`💰 Checking balance...`)
    
    const balance = await wallet.getBalance("eth")
    const balanceInWei = BigInt(balance.toString())
    
    console.log(`   Balance: ${formatEther(balanceInWei)} ETH`)

    // Fetch ETH price for USD conversion
    const ethPriceResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/eth-price`)
    const { price: ethPriceUsd } = await ethPriceResponse.json()
    
    const balanceInUsd = Number(formatEther(balanceInWei)) * ethPriceUsd
    console.log(`   Balance: $${balanceInUsd.toFixed(4)} USD`)

    // Check if balance is sufficient (minimum $0.01)
    const minAmountEth = MIN_AMOUNT_USD / ethPriceUsd
    const minAmountWei = BigInt(Math.floor(minAmountEth * 1e18))

    if (balanceInWei < minAmountWei) {
      console.log(`⚠️ Bot #${walletIndex + 1} balance insufficient (${balanceInUsd.toFixed(4)} < ${MIN_AMOUNT_USD}) - Skipping`)
      
      // Log insufficient balance
      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        action: "swap_skipped",
        message: `[System] Saldo Bot #${walletIndex + 1} tidak cukup ($${balanceInUsd.toFixed(2)} < $${MIN_AMOUNT_USD}). Bumping dihentikan.`,
        status: "warning",
        timestamp: new Date().toISOString(),
      })

      // Check if all wallets are depleted
      let allDepleted = true
      for (let i = 0; i < botWallets.length; i++) {
        const w = botWallets[i]
        const wWallet = await Wallet.fetch(w.coinbase_wallet_id)
        const wBalance = await wWallet.getBalance("eth")
        const wBalanceWei = BigInt(wBalance.toString())
        
        if (wBalanceWei >= minAmountWei) {
          allDepleted = false
          break
        }
      }

      if (allDepleted) {
        console.log("❌ All bot wallets depleted - Stopping session")
        
        await supabase
          .from("bot_sessions")
          .update({ status: "stopped" })
          .eq("id", sessionId)

        await supabase.from("bot_logs").insert({
          user_address: user_address.toLowerCase(),
          action: "session_stopped",
          message: `[System] All bot balances below $${MIN_AMOUNT_USD}. Bumping session completed.`,
          status: "info",
          timestamp: new Date().toISOString(),
        })

        return NextResponse.json({
          message: "All bot wallets depleted - Session stopped",
          allDepleted: true,
        })
      }

      // Move to next wallet
      const nextIndex = (wallet_rotation_index + 1) % 5
      await supabase
        .from("bot_sessions")
        .update({ wallet_rotation_index: nextIndex })
        .eq("id", sessionId)

      return NextResponse.json({
        message: "Bot wallet balance insufficient - Skipped",
        skipped: true,
        nextIndex,
      })
    }

    // Step 7: Calculate swap amount in ETH
    const amountUsdValue = parseFloat(amount_usd)
    const amountEth = amountUsdValue / ethPriceUsd
    const amountWei = BigInt(Math.floor(amountEth * 1e18))

    console.log(`💱 Swap Parameters:`)
    console.log(`   Amount: $${amountUsdValue} USD`)
    console.log(`   Amount: ${formatEther(amountWei)} ETH`)
    console.log(`   Target Token: ${token_address}`)

    // Step 8: Get swap quote from 0x API
    console.log(`📊 Fetching swap quote from 0x API...`)
    
    const zeroXApiKey = process.env.ZEROX_API_KEY
    if (!zeroXApiKey) {
      console.error("❌ 0x API key not configured")
      return NextResponse.json(
        { error: "0x API key not configured" },
        { status: 500 }
      )
    }

    const quoteParams = new URLSearchParams({
      chainId: "8453", // Base Mainnet
      sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // ETH
      buyToken: token_address,
      sellAmount: amountWei.toString(),
      taker: botWallet.smart_account_address,
      slippagePercentage: "0.01", // 1% slippage
    })

    const quoteResponse = await fetch(
      `https://api.0x.org/swap/v1/quote?${quoteParams.toString()}`,
      {
        headers: {
          "0x-api-key": zeroXApiKey,
        },
      }
    )

    if (!quoteResponse.ok) {
      const errorData = await quoteResponse.json()
      console.error("❌ 0x API error:", errorData)
      return NextResponse.json(
        { error: "Failed to get swap quote", details: errorData },
        { status: 500 }
      )
    }

    const quote = await quoteResponse.json()
    console.log(`✅ Got swap quote:`)
    console.log(`   To: ${quote.to}`)
    console.log(`   Data: ${quote.data.slice(0, 66)}...`)
    console.log(`   Value: ${formatEther(BigInt(quote.value))} ETH`)

    // Step 9: Create swap log entry
    const { data: logEntry, error: logError } = await supabase
      .from("bot_logs")
      .insert({
        user_address: user_address.toLowerCase(),
        action: "swap_executing",
        message: `[Bot #${walletIndex + 1}] Melakukan swap senilai $${amountUsdValue.toFixed(2)} ke Target Token...`,
        status: "pending",
        timestamp: new Date().toISOString(),
      })
      .select()
      .single()

    if (logError) {
      console.error("❌ Failed to create log entry:", logError)
    }

    // Step 10: Execute swap using CDP invokeContract (gasless!)
    console.log(`🚀 Executing swap with CDP (gasless)...`)
    
    try {
      const invocation = await wallet.invokeContract({
        contractAddress: quote.to,
        method: "swap", // Generic method name (0x will handle the actual function)
        args: {
          data: quote.data,
        },
        amount: BigInt(quote.value),
        assetId: "eth",
      })

      // Wait for transaction to complete
      await invocation.wait()
      
      const txHash = invocation.getTransactionHash()
      
      console.log(`✅ Swap executed successfully!`)
      console.log(`   Transaction: ${txHash}`)

      // Update log with tx hash
      if (logEntry) {
        await supabase
          .from("bot_logs")
          .update({
            tx_hash: txHash,
            status: "success",
            message: `[Bot #${walletIndex + 1}] Melakukan swap senilai $${amountUsdValue.toFixed(2)} ke Target Token... [Lihat Transaksi](https://basescan.org/tx/${txHash})`,
          })
          .eq("id", logEntry.id)
      }

      // Log remaining balance
      const newBalance = await wallet.getBalance("eth")
      const newBalanceWei = BigInt(newBalance.toString())
      const newBalanceUsd = Number(formatEther(newBalanceWei)) * ethPriceUsd

      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        action: "balance_check",
        message: `[System] Remaining balance in Bot #${walletIndex + 1}: ${formatEther(newBalanceWei)} ETH ($${newBalanceUsd.toFixed(2)})`,
        status: "info",
        timestamp: new Date().toISOString(),
      })

      // Step 11: Update wallet rotation index
      const nextIndex = (wallet_rotation_index + 1) % 5
      await supabase
        .from("bot_sessions")
        .update({ wallet_rotation_index: nextIndex })
        .eq("id", sessionId)

      console.log(`✅ Updated rotation index to ${nextIndex}`)

      return NextResponse.json({
        message: "Swap executed successfully",
        txHash,
        nextIndex,
        remainingBalance: formatEther(newBalanceWei),
        remainingBalanceUsd: newBalanceUsd.toFixed(2),
      })
    } catch (swapError: any) {
      console.error("❌ Swap execution failed:", swapError)

      // Update log with error
      if (logEntry) {
        await supabase
          .from("bot_logs")
          .update({
            status: "error",
            message: `[Bot #${walletIndex + 1}] Swap gagal: ${swapError.message}`,
          })
          .eq("id", logEntry.id)
      }

      return NextResponse.json(
        { error: "Swap execution failed", details: swapError.message },
        { status: 500 }
      )
    }
  } catch (error: any) {
    console.error("❌ Error in execute-swap:", error)
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      { status: 500 }
    )
  }
}
