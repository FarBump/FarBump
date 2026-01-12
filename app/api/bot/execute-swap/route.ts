import { NextRequest, NextResponse } from "next/server"
import { formatEther, parseEther, isAddress, type Address, type Hex, createPublicClient, http } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Constants
const MIN_AMOUNT_USD = 0.01

// 0x Protocol Router (for swap quotes)
const ZEROX_ROUTER = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF"

// Public client for balance checks
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

/**
 * API Route: Execute Swap for Bot Smart Account using CDP Server Wallets V2
 * 
 * CDP V2 Smart Account Flow:
 * 1. Fetch Smart Account address and Owner address from database
 * 2. Check Smart Account balance (must be >= MIN_AMOUNT_USD)
 * 3. Get swap quote from 0x API v2 (with Universal Router support)
 * 4. Use CDP SDK to sign and execute transaction via Smart Account
 * 5. Native gas sponsorship (no Paymaster needed!)
 * 6. Update wallet rotation index
 * 7. Log all activities
 * 
 * Benefits of Smart Accounts:
 * - Native gas sponsorship by CDP (no Paymaster allowlist issues)
 * - Account abstraction (ERC-4337)
 * - Secure signing by CDP (no private key exposure)
 * - Multi-sig capabilities
 * - Simpler and more reliable than User Operations
 * 
 * Universal Router Support:
 * - Uses 0x API v2 which automatically leverages Universal Router
 * - Enables dynamic token swaps without requiring allowlist for each token
 * - Works gaslessly with CDP server wallets v2
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
      .eq("status", "running")
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

    const smartAccountAddress = botWallet.smart_account_address as Address
    const ownerAddress = botWallet.owner_address as Address

    console.log(`🤖 Selected Bot #${walletIndex + 1}:`)
    console.log(`   Smart Account: ${smartAccountAddress}`)
    console.log(`   Owner Account: ${ownerAddress}`)

    // Step 4: Initialize CDP Client V2
    console.log("🔧 Initializing Coinbase CDP SDK V2...")
    
    const apiKeyId = process.env.CDP_API_KEY_ID
    const apiKeySecret = process.env.CDP_API_KEY_SECRET

    if (!apiKeyId || !apiKeySecret) {
      console.error("❌ Missing CDP credentials")
      return NextResponse.json(
        { error: "CDP credentials not configured" },
        { status: 500 }
      )
    }

    // CDP Client auto-loads from environment variables
    const cdp = new CdpClient()
    console.log(`✅ CDP Client V2 initialized`)

    // Step 5: Check Smart Account balance using public RPC
    console.log(`💰 Checking Smart Account balance...`)
    
    const balance = await publicClient.getBalance({ address: smartAccountAddress })
    
    console.log(`   Balance: ${formatEther(balance)} ETH`)

    // Fetch ETH price for USD conversion
    const ethPriceResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/eth-price`)
    const { price: ethPriceUsd } = await ethPriceResponse.json()
    
    const balanceInUsd = Number(formatEther(balance)) * ethPriceUsd
    console.log(`   Balance: $${balanceInUsd.toFixed(4)} USD`)

    // Check if balance is sufficient (minimum $0.01)
    const minAmountEth = MIN_AMOUNT_USD / ethPriceUsd
    const minAmountWei = BigInt(Math.floor(minAmountEth * 1e18))

    if (balance < minAmountWei) {
      console.log(`⚠️ Bot #${walletIndex + 1} balance insufficient (${balanceInUsd.toFixed(4)} < ${MIN_AMOUNT_USD}) - Skipping`)
      
      // Log insufficient balance
      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: "0",
        action: "swap_skipped",
        message: `[System] Saldo Bot #${walletIndex + 1} tidak cukup ($${balanceInUsd.toFixed(2)} < $${MIN_AMOUNT_USD}). Bumping dihentikan.`,
        status: "warning",
        timestamp: new Date().toISOString(),
      })

      // Check if all wallets are depleted
      let allDepleted = true
      for (let i = 0; i < botWallets.length; i++) {
        const w = botWallets[i]
        const wBalance = await publicClient.getBalance({ 
          address: w.smart_account_address as Address 
        })
        
        if (wBalance >= minAmountWei) {
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
          wallet_address: smartAccountAddress,
          token_address: token_address,
          amount_wei: "0",
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

    // Step 8: Get swap quote from 0x API v2 (with Universal Router support)
    // 0x API v2 automatically uses Universal Router when appropriate
    // This enables dynamic token swaps without requiring allowlist for each token
    console.log(`📊 Fetching swap quote from 0x API v2 (Universal Router)...`)
    
    const zeroXApiKey = process.env.ZEROX_API_KEY
    if (!zeroXApiKey) {
      console.error("❌ 0x API key not configured")
      return NextResponse.json(
        { error: "0x API key not configured" },
        { status: 500 }
      )
    }

    // Validate token address before making API call
    if (!isAddress(token_address)) {
      console.error(`❌ Invalid token address: ${token_address}`)
      return NextResponse.json(
        { error: "Invalid token address" },
        { status: 400 }
      )
    }

    // For native ETH swaps, use proper parameters
    // Reference: https://0x.org/docs/api/swap-v2#get-quote
    // IMPORTANT: For native ETH swaps, we need to ensure:
    // 1. sellToken is the ETH placeholder address
    // 2. buyToken is the target token address
    // 3. taker is the address that holds the ETH (Smart Account)
    // 4. sellAmount is in wei
    // 5. For very small amounts, we may need to use buyAmount instead
    
    // Try with sellAmount first (standard approach)
    let quoteParams = new URLSearchParams({
      chainId: "8453", // Base Mainnet
      sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // Native ETH placeholder
      buyToken: token_address.toLowerCase(), // Target token (ensure lowercase)
      sellAmount: amountWei.toString(), // Amount in wei
      taker: smartAccountAddress.toLowerCase(), // Smart Account holds the ETH
      slippagePercentage: "1.0", // 1% slippage
      // Note: For native ETH, no allowance is needed (ETH is sent directly)
      // The taker parameter specifies who holds the ETH balance (allowance holder)
    })
    
    // If amount is very small (< 0.001 ETH), try using buyAmount instead
    // This can help with tokens that have very high prices
    const amountEth = Number(formatEther(amountWei))
    if (amountEth < 0.001) {
      console.log(`⚠️ Very small swap amount (${amountEth} ETH), trying alternative approach...`)
      // For very small amounts, we might need to specify buyAmount instead
      // But first, let's try the standard approach
    }

    const quoteUrl = `https://api.0x.org/swap/v2/quote?${quoteParams.toString()}`
    console.log(`📊 Requesting quote from 0x API:`)
    console.log(`   URL: ${quoteUrl}`)
    console.log(`   Sell Token: ETH (native)`)
    console.log(`   Buy Token: ${token_address}`)
    console.log(`   Sell Amount: ${formatEther(amountWei)} ETH (${amountWei.toString()} wei)`)
    console.log(`   Taker (Allowance Holder): ${smartAccountAddress}`)
    
    let quoteResponse = await fetch(quoteUrl, {
      headers: {
        "0x-api-key": zeroXApiKey,
      },
    })

    // If "no Route matched" error, try alternative approach with buyAmount
    // This can help with tokens that have very high prices or very small amounts
    if (!quoteResponse.ok) {
      let errorData: any = {}
      try {
        errorData = await quoteResponse.json()
      } catch (e) {
        errorData = { message: quoteResponse.statusText }
      }
      
      // If "no Route matched", try with buyAmount instead (for high-priced tokens)
      if (errorData.message && (errorData.message.includes("no Route matched") || errorData.message.includes("No route found"))) {
        console.log(`⚠️ No route found with sellAmount, trying with buyAmount (for high-priced tokens)...`)
        
        // Try with a small buyAmount (1 unit of token)
        // This works better for tokens with very high prices
        const alternativeParams = new URLSearchParams({
          chainId: "8453",
          sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          buyToken: token_address.toLowerCase(),
          buyAmount: "1", // Try to buy 1 unit of token
          taker: smartAccountAddress.toLowerCase(),
          slippagePercentage: "5.0", // Higher slippage for small amounts
        })
        
        const alternativeUrl = `https://api.0x.org/swap/v2/quote?${alternativeParams.toString()}`
        console.log(`   Trying alternative with buyAmount: ${alternativeUrl}`)
        
        const alternativeResponse = await fetch(alternativeUrl, {
          headers: {
            "0x-api-key": zeroXApiKey,
          },
        })
        
        if (alternativeResponse.ok) {
          console.log(`✅ Alternative approach worked! Using buyAmount instead of sellAmount`)
          quoteResponse = alternativeResponse
        } else {
          // Alternative also failed, use original error
          console.error("❌ Alternative approach also failed")
        }
      }
    }

    if (!quoteResponse.ok) {
      let errorData: any = {}
      try {
        errorData = await quoteResponse.json()
      } catch (e) {
        errorData = { message: quoteResponse.statusText }
      }
      
      console.error("❌ 0x API error:", errorData)
      console.error("   Status:", quoteResponse.status)
      console.error("   Request params:", quoteParams.toString())
      console.error("   Token address:", token_address)
      console.error("   Smart Account:", smartAccountAddress)
      console.error("   Amount:", amountWei.toString())
      console.error("   Amount USD:", amountUsdValue)
      console.error("   Amount ETH:", formatEther(amountWei))
      
      // Provide more helpful error message
      let errorMessage = "Failed to get swap quote"
      if (errorData.message) {
        if (errorData.message.includes("no Route matched") || errorData.message.includes("No route found")) {
          errorMessage = `No swap route found for token ${token_address}. Possible reasons: 1) Token has no liquidity on Base network, 2) Swap amount too small, 3) Token not tradeable. Please verify the token address is correct and has liquidity.`
        } else if (errorData.message.includes("Insufficient liquidity")) {
          errorMessage = `Insufficient liquidity for token ${token_address}. Try a smaller amount or a different token.`
        } else if (errorData.message.includes("Invalid token")) {
          errorMessage = `Invalid token address: ${token_address}. Please verify the token exists on Base network.`
        } else {
          errorMessage = errorData.message
        }
      }
      
      // Log error to database
      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: amountWei.toString(),
        action: "swap_failed",
        message: `[Bot #${walletIndex + 1}] Swap quote failed: ${errorMessage}`,
        status: "error",
        error_details: errorData,
        timestamp: new Date().toISOString(),
      })
      
      return NextResponse.json(
        { 
          error: errorMessage,
          details: errorData,
          hint: "Please verify: 1) Token address is correct, 2) Token has liquidity on Base network, 3) Swap amount is sufficient (minimum $0.01 USD). You can check token liquidity on BaseScan or DEX aggregators."
        },
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
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: amountWei.toString(),
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

    // Step 10: Execute swap using CDP Smart Account
    // Use CDP Smart Account directly to execute swap transaction
    // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/sending-transactions
    console.log(`🚀 Executing swap with CDP Smart Account (gasless)...`)
    
    try {
      // Get the Smart Account directly (not owner account)
      // CDP Smart Accounts can execute transactions directly with gas sponsorship
      console.log(`   → Getting Smart Account...`)
      
      const smartAccount = await cdp.evm.getSmartAccount({ address: smartAccountAddress })
      
      if (!smartAccount) {
        throw new Error("Failed to get Smart Account from CDP")
      }
      
      console.log(`   ✅ Smart Account retrieved`)
      console.log(`   → Preparing swap transaction...`)
      console.log(`   → To: ${quote.to}`)
      console.log(`   → Value: ${formatEther(BigInt(quote.value))} ETH`)
      console.log(`   → Data length: ${quote.data.length} bytes`)
      
      // Execute swap transaction from Smart Account
      // CDP will handle gas sponsorship automatically
      const userOpHash = await smartAccount.sendTransaction({
        to: quote.to as Address,
        data: quote.data as Hex,
        value: BigInt(quote.value),
      })
      
      console.log(`   ✅ User Operation submitted: ${userOpHash}`)
      console.log(`   → Waiting for confirmation...`)
      
      // Wait for user operation to be confirmed
      const userOpReceipt = await smartAccount.waitForUserOperation({
        userOpHash,
      })
      
      if (!userOpReceipt || !userOpReceipt.transactionHash) {
        throw new Error("User operation completed but no transaction hash received")
      }
      
      const txHash = userOpReceipt.transactionHash as `0x${string}`
      
      console.log(`✅ Swap executed successfully!`)
      console.log(`   Transaction: ${txHash}`)
      console.log(`   Explorer: https://basescan.org/tx/${txHash}`)

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
      const newBalance = await publicClient.getBalance({ address: smartAccountAddress })
      const newBalanceUsd = Number(formatEther(newBalance)) * ethPriceUsd

      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: newBalance.toString(),
        action: "balance_check",
        message: `[System] Remaining balance in Bot #${walletIndex + 1}: ${formatEther(newBalance)} ETH ($${newBalanceUsd.toFixed(2)})`,
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
        remainingBalance: formatEther(newBalance),
        remainingBalanceUsd: newBalanceUsd.toFixed(2),
      })
    } catch (swapError: any) {
      console.error("❌ Swap execution failed:", swapError)
      console.error("   Error details:", swapError.message)
      if (swapError.response) {
        console.error("   API Response:", swapError.response.data)
      }

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
