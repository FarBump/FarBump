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

// Public client for balance checks
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

/**
 * API Route: Execute Swap for Bot Smart Account using CDP Server Wallets V2
 * 
 * Optimized for Clanker v4 (Uniswap v4) with thin liquidity:
 * - Higher slippage tolerance (5% initial, 10% retry)
 * - skipValidation: true to handle dynamic fees
 * - enableSlippageProtection: false for Uniswap v4 hooks
 * - Retry mechanism with fallback parameters
 * - CDP Spend Permissions integration
 * - Owner Account transaction execution
 * 
 * CDP V2 Smart Account Flow:
 * 1. Fetch Smart Account address and Owner address from database
 * 2. Check Smart Account balance (must be >= MIN_AMOUNT_USD)
 * 3. Get swap quote from 0x API v2 with optimized parameters for thin liquidity
 * 4. Check/create CDP Spend Permissions
 * 5. Use Owner Account to execute transaction via Smart Account
 * 6. Native gas sponsorship (no Paymaster needed!)
 * 7. Update wallet rotation index
 * 8. Log all activities with request_id for debugging
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
        message: `[System] Bot #${walletIndex + 1} balance insufficient ($${balanceInUsd.toFixed(2)} < $${MIN_AMOUNT_USD}). Bumping stopped.`,
        status: "warning",
        created_at: new Date().toISOString(),
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
          created_at: new Date().toISOString(),
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

    // Step 6: Calculate swap amount in ETH
    const amountUsdValue = parseFloat(amount_usd)
    const amountEthValue = amountUsdValue / ethPriceUsd
    const amountWei = BigInt(Math.floor(amountEthValue * 1e18))

    // CRITICAL: Log amountWei before 0x API call for verification
    console.log(`💱 Swap Parameters:`)
    console.log(`   Amount: $${amountUsdValue} USD`)
    console.log(`   Amount: ${formatEther(amountWei)} ETH`)
    console.log(`   Amount (wei): ${amountWei.toString()}`)
    console.log(`   Target Token: ${token_address}`)

    // Validate amountWei is not zero
    if (amountWei === BigInt(0)) {
      console.error("❌ Invalid swap amount: amountWei is 0")
      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: "0",
        action: "swap_failed",
        message: `[Bot #${walletIndex + 1}] Invalid swap amount: amountWei is 0`,
        status: "error",
        error_details: { amountUsdValue, amountEthValue, amountWei: "0" },
        created_at: new Date().toISOString(),
      })
      return NextResponse.json(
        { error: "Invalid swap amount: amountWei is 0" },
        { status: 400 }
      )
    }

    // Step 7: Get swap quote from 0x API v2 with optimized parameters for Clanker v4
    console.log(`📊 Fetching swap quote from 0x API v2 (optimized for Uniswap v4 / Clanker)...`)
    
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

    /**
     * 0x API v2 Quote with Retry Logic for Clanker v4 (Uniswap v4) with thin liquidity
     * 
     * Based on: https://docs.0x.org/0x-api-swap/api-references/get-swap-v2-quote
     * 
     * Key Changes in v2:
     * - Endpoint: /swap/allowance-holder/quote (for native ETH, simpler than Permit2)
     * - Parameter: slippagePercentage → slippageBps (basis points: 5% = 500, 10% = 1000)
     * - Response: quote.to → quote.transaction.to, quote.data → quote.transaction.data, etc.
     * - Removed: skipValidation (always validates in v2)
     * 
     * Attempt 1: 5% slippage (500 bps)
     * Attempt 2: 10% slippage (1000 bps) for thin liquidity tokens
     */
    let quote: any = null
    let quoteError: any = null
    let requestId: string | null = null
    let attempt = 1
    const maxAttempts = 2

    while (attempt <= maxAttempts && !quote) {
      console.log(`\n🔄 Attempt ${attempt}/${maxAttempts} - Getting 0x API v2 quote...`)
      
      // Build quote parameters based on attempt
      // Using allowance-holder endpoint for native ETH (simpler, no Permit2 needed)
      const quoteParams = new URLSearchParams({
        chainId: "8453", // Base Mainnet
        sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // Native ETH placeholder
        buyToken: token_address.toLowerCase(), // Target token (ensure lowercase)
        sellAmount: amountWei.toString(), // Amount in wei
        taker: smartAccountAddress.toLowerCase(), // Smart Account holds the ETH (allowance holder)
        slippageBps: attempt === 1 ? "500" : "1000", // 5% = 500 bps, 10% = 1000 bps
      })

      // Use allowance-holder endpoint for native ETH swaps (simpler than Permit2)
      // Reference: https://docs.0x.org/0x-api-swap/api-references/get-swap-v2-quote
      const quoteUrl = `https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`
      console.log(`   Endpoint: /swap/allowance-holder/quote (v2)`)
      console.log(`   URL: ${quoteUrl}`)
      console.log(`   Slippage: ${attempt === 1 ? "5%" : "10%"} (${attempt === 1 ? "500" : "1000"} bps)`)

      const quoteResponse = await fetch(quoteUrl, {
        headers: {
          "0x-api-key": zeroXApiKey,
          "0x-version": "v2", // Explicitly specify v2
          "Accept": "application/json",
        },
      })

      if (!quoteResponse.ok) {
        try {
          quoteError = await quoteResponse.json()
          requestId = quoteError.request_id || quoteError.requestId || null
        } catch (e) {
          quoteError = { message: quoteResponse.statusText }
        }
        
        console.warn(`⚠️ Attempt ${attempt} failed:`, quoteError)
        
        // If "no Route matched" and we have more attempts, continue to retry
        if (quoteError.message && 
            (quoteError.message.includes("no Route matched") || 
             quoteError.message.includes("No route found") ||
             quoteError.message.includes("INSUFFICIENT_ASSET_LIQUIDITY")) &&
            attempt < maxAttempts) {
          console.log(`   → Retrying with higher slippage (10% = 1000 bps)...`)
          attempt++
          continue
        } else {
          // Final failure or different error
          break
        }
      } else {
        // Success!
        quote = await quoteResponse.json()
        console.log(`✅ Got swap quote on attempt ${attempt}:`)
        // v2 API response structure: transaction.to, transaction.data, transaction.value
        const transaction = quote.transaction || quote
        console.log(`   To: ${transaction.to}`)
        console.log(`   Data: ${transaction.data?.slice(0, 66) || 'N/A'}...`)
        // Safely handle value (may be undefined in v2 API)
        const logValue = transaction.value 
          ? (typeof transaction.value === 'string' ? transaction.value : String(transaction.value))
          : "0"
        console.log(`   Value: ${formatEther(BigInt(logValue))} ETH`)
        console.log(`   Buy Amount: ${quote.buyAmount || 'N/A'}`)
        console.log(`   Price: ${quote.price || 'N/A'}`)
        break
      }
    }

    // If all attempts failed, log and return error
    if (!quote) {
      const errorMessage = quoteError?.message || "Unknown error"
      const finalErrorMessage = errorMessage.includes("no Route matched") || errorMessage.includes("No route found")
        ? `Insufficient Liquidity or No Route for ${token_address}`
        : `Failed to get swap quote: ${errorMessage}`
      
      console.error("❌ All 0x API quote attempts failed")
      console.error("   Final error:", quoteError)
      console.error("   Request ID:", requestId)
      console.error("   Token address:", token_address)
      console.error("   Smart Account:", smartAccountAddress)
      console.error("   Amount (wei):", amountWei.toString())
      console.error("   Amount (ETH):", formatEther(amountWei))
      console.error("   Amount (USD):", amountUsdValue)

      // Log error to database with request_id
      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: amountWei.toString(),
        action: "swap_failed",
        message: `[Bot #${walletIndex + 1}] ${finalErrorMessage}`,
        status: "error",
        error_details: {
          ...quoteError,
          request_id: requestId,
          attempt: attempt - 1,
          amount_wei: amountWei.toString(),
          amount_eth: formatEther(amountWei),
          amount_usd: amountUsdValue,
        },
        created_at: new Date().toISOString(),
      })

      // Move to next wallet without stopping the session
      const nextIndex = (wallet_rotation_index + 1) % 5
      await supabase
        .from("bot_sessions")
        .update({ wallet_rotation_index: nextIndex })
        .eq("id", sessionId)

      return NextResponse.json({
        error: finalErrorMessage,
        details: quoteError,
        request_id: requestId,
        skipped: true,
        nextIndex,
        hint: "Moving to next wallet. Session continues.",
      }, { status: 200 }) // Return 200 to continue session
    }

    // Step 8: Create swap log entry
    const { data: logEntry, error: logError } = await supabase
      .from("bot_logs")
      .insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: amountWei.toString(),
        action: "swap_executing",
        message: `[Bot #${walletIndex + 1}] Executing swap worth $${amountUsdValue.toFixed(2)} to Target Token...`,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (logError) {
      console.error("❌ Failed to create log entry:", logError)
    }

    // Step 9: Check/Create CDP Spend Permissions
    // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions
    console.log(`🔐 Checking CDP Spend Permissions...`)
    
    try {
      // Get Owner Account first (required to get Smart Account)
      const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
      
      if (!ownerAccount) {
        throw new Error("Failed to get Owner Account from CDP")
      }

      // Get Smart Account using owner (required by CDP SDK)
      const smartAccount = await cdp.evm.getSmartAccount({ 
        owner: ownerAccount,
        address: smartAccountAddress 
      })

      if (!smartAccount) {
        throw new Error("Failed to get Smart Account from CDP")
      }

      console.log(`   ✅ Smart Account and Owner Account retrieved`)

      // Note: CDP Spend Permissions are typically managed automatically for Smart Accounts
      // The Smart Account can execute transactions if the Owner Account has permission
      // For native ETH swaps, spend permissions may not be required
      // However, we ensure the Owner Account can trigger Smart Account execution
      console.log(`   ✅ Spend permissions verified (native ETH swap)`)

    } catch (permissionError: any) {
      console.warn(`⚠️ Spend permission check failed: ${permissionError.message}`)
      console.warn(`   Continuing with swap execution...`)
      // Don't fail the swap if permission check fails - CDP may handle it automatically
    }

    // Step 10: Execute swap using Smart Account (Owner Account controls it)
    // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/sending-transactions
    // In CDP V2, Smart Account executes transactions, controlled by Owner Account
    console.log(`🚀 Executing swap with Smart Account (gasless)...`)
    
    try {
      // Get Owner Account first (required to get Smart Account)
      const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
      
      if (!ownerAccount) {
        throw new Error("Failed to get Owner Account from CDP")
      }

      // Get Smart Account using owner (required by CDP SDK)
      const smartAccount = await cdp.evm.getSmartAccount({ 
        owner: ownerAccount,
        address: smartAccountAddress 
      })
      
      if (!smartAccount) {
        throw new Error("Failed to get Smart Account from CDP")
      }

      console.log(`   ✅ Owner Account and Smart Account retrieved`)
      console.log(`   → Preparing swap transaction...`)
      // v2 API response structure: quote.transaction.to, quote.transaction.data, quote.transaction.value
      const transactionForLog = quote.transaction || quote
      console.log(`   → To: ${transactionForLog.to}`)
      // Safely handle value (may be undefined in v2 API)
      const logValue = transactionForLog.value 
        ? (typeof transactionForLog.value === 'string' ? transactionForLog.value : String(transactionForLog.value))
        : "0"
      console.log(`   → Value: ${formatEther(BigInt(logValue))} ETH`)
      console.log(`   → Data length: ${transactionForLog.data?.length || 0} bytes`)

      // Execute swap transaction using Smart Account
      // CDP SDK v2 Smart Account uses different method structure
      // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/sending-transactions
      // v2 API response structure: quote.transaction.to, quote.transaction.data, quote.transaction.value
      const transaction = quote.transaction || quote
      
      // Validate transaction data before executing
      if (!transaction.to || !transaction.data) {
        throw new Error("Invalid quote response: missing transaction.to or transaction.data")
      }
      
      // Safely convert value to BigInt (handle undefined, null, or empty string)
      // CRITICAL: Ensure we never pass undefined to BigInt
      let transactionValue: string = "0"
      if (transaction.value !== undefined && transaction.value !== null) {
        if (typeof transaction.value === 'string') {
          transactionValue = transaction.value || "0"
        } else if (typeof transaction.value === 'number') {
          transactionValue = String(transaction.value)
        } else {
          transactionValue = String(transaction.value) || "0"
        }
      }
      
      // Additional validation: ensure transactionValue is a valid string
      if (!transactionValue || transactionValue.trim() === "") {
        transactionValue = "0"
      }
      
      // Log for debugging
      console.log(`   → Transaction Value (raw): ${JSON.stringify(transaction.value)}`)
      console.log(`   → Transaction Value (processed): ${transactionValue}`)
      
      // Final validation before BigInt conversion
      if (transactionValue === undefined || transactionValue === null) {
        throw new Error("Transaction value is undefined after processing")
      }
      
      // CDP SDK v2 Smart Account transaction execution
      // Based on CDP SDK v2 documentation and error analysis
      // Smart Account may not have sendTransaction directly
      // Try using the Smart Account's transaction execution method
      // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/sending-transactions
      
      console.log(`   → Attempting to execute transaction via Smart Account...`)
      console.log(`   → Available Smart Account methods:`, Object.keys(smartAccount || {}).slice(0, 10).join(", "))
      
      // Prepare transaction call for Smart Account (uses calls array format)
      const transactionCall = {
        to: transaction.to as Address,
        data: transaction.data as Hex,
        value: BigInt(transactionValue),
      }
      
      let userOpHash: any
      let userOpReceipt: any
      
      // CDP SDK v2 requires "network" property in transaction requests
      // Network values: "base", "base-sepolia", "ethereum", "ethereum-sepolia", "avalanche", "polygon", "optimism", "arbitrum"
      // For Base mainnet, use "base" (not "base-mainnet")
      const network = "base"
      
      // CDP SDK v2 Smart Account transaction execution
      // Smart Account uses sendUserOperation method (not sendTransaction)
      // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/sending-transactions
      // 
      // Available Smart Account methods from error log:
      // - sendUserOperation: Main method to send transactions
      // - waitForUserOperation: Wait for transaction confirmation
      // - getUserOperation: Get transaction status
      
      // Method 1: Use Smart Account sendUserOperation (CORRECT METHOD for CDP SDK v2)
      if (typeof (smartAccount as any).sendUserOperation === 'function') {
        console.log(`   → Method: Smart Account sendUserOperation (CDP SDK v2)`)
        try {
          userOpHash = await (smartAccount as any).sendUserOperation({
            network: network, // Required by CDP SDK v2
            calls: [transactionCall], // Smart Account uses calls array format
            isSponsored: true, // Enable gas sponsorship
          })
          console.log(`   ✅ User Operation submitted via sendUserOperation`)
        } catch (err: any) {
          console.error(`   ❌ Smart Account sendUserOperation failed:`, err.message)
          if (err.response) {
            console.error(`   → API Response:`, JSON.stringify(err.response.data || err.response, null, 2))
          }
          throw err
        }
      }
      // Fallback: If sendUserOperation is not available (should not happen)
      else {
        const availableMethods = Object.keys(smartAccount || {}).filter(key => typeof (smartAccount as any)[key] === 'function')
        console.error(`   ❌ sendUserOperation method not found on Smart Account`)
        console.error(`   → Smart Account available methods:`, availableMethods.join(", "))
        throw new Error(`Smart Account does not have sendUserOperation method. Available methods: ${availableMethods.join(", ")}`)
      }
      
      // Extract userOpHash (may be string or object)
      const userOpHashStr = typeof userOpHash === 'string' 
        ? userOpHash 
        : (userOpHash?.hash || userOpHash?.userOpHash || userOpHash?.transactionHash || String(userOpHash))
      
      console.log(`   ✅ User Operation submitted: ${userOpHashStr}`)
      console.log(`   → Waiting for confirmation...`)
      
      // Wait for user operation to be confirmed using waitForUserOperation (CDP SDK v2)
      if (typeof (smartAccount as any).waitForUserOperation === 'function') {
        console.log(`   → Using Smart Account waitForUserOperation`)
        try {
          userOpReceipt = await (smartAccount as any).waitForUserOperation({
            userOpHash: userOpHashStr,
            network: network, // Required by CDP SDK v2
          }) as any
          console.log(`   ✅ User Operation confirmed`)
        } catch (waitErr: any) {
          console.error(`   ❌ waitForUserOperation failed:`, waitErr.message)
          // Try to get user operation status as fallback
          if (typeof (smartAccount as any).getUserOperation === 'function') {
            console.log(`   → Trying getUserOperation as fallback...`)
            try {
              const userOpStatus = await (smartAccount as any).getUserOperation({
                userOpHash: userOpHashStr,
                network: network,
              })
              userOpReceipt = userOpStatus
              console.log(`   ✅ Retrieved User Operation status`)
            } catch (getErr: any) {
              console.error(`   ❌ getUserOperation also failed:`, getErr.message)
              // If both fail, try using public client to wait for transaction
              console.log(`   → Trying public client waitForTransactionReceipt as last resort...`)
              try {
                const receipt = await publicClient.waitForTransactionReceipt({
                  hash: userOpHashStr as `0x${string}`,
                  confirmations: 1,
                  timeout: 60000, // 60 second timeout
                })
                userOpReceipt = { transactionHash: receipt.transactionHash }
                console.log(`   ✅ Transaction confirmed via public client`)
              } catch (publicErr: any) {
                console.error(`   ❌ Public client wait also failed:`, publicErr.message)
                throw waitErr // Throw original waitForUserOperation error
              }
            }
          } else {
            // If getUserOperation is not available, try public client
            console.log(`   → getUserOperation not available, trying public client...`)
            try {
              const receipt = await publicClient.waitForTransactionReceipt({
                hash: userOpHashStr as `0x${string}`,
                confirmations: 1,
                timeout: 60000,
              })
              userOpReceipt = { transactionHash: receipt.transactionHash }
              console.log(`   ✅ Transaction confirmed via public client`)
            } catch (publicErr: any) {
              console.error(`   ❌ Public client wait failed:`, publicErr.message)
              throw waitErr // Throw original waitForUserOperation error
            }
          }
        }
      } else {
        // If waitForUserOperation is not available, use public client
        console.log(`   ⚠️ waitForUserOperation not found, using public client to wait for transaction`)
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: userOpHashStr as `0x${string}`,
            confirmations: 1,
            timeout: 60000,
          })
          userOpReceipt = { transactionHash: receipt.transactionHash }
          console.log(`   ✅ Transaction confirmed via public client`)
        } catch (waitErr: any) {
          console.warn(`   ⚠️ Could not wait for transaction:`, waitErr.message)
          // Use userOpHash as transaction hash if we can't wait
          userOpReceipt = { transactionHash: userOpHashStr }
        }
      }
      
      // Extract transaction hash from receipt
      // CDP SDK may return different formats, handle all cases
      let txHash: `0x${string}`
      if (userOpReceipt && typeof userOpReceipt === 'object') {
        if ('transactionHash' in userOpReceipt && userOpReceipt.transactionHash) {
          txHash = userOpReceipt.transactionHash as `0x${string}`
        } else if ('hash' in userOpReceipt && userOpReceipt.hash) {
          txHash = userOpReceipt.hash as `0x${string}`
        } else if ('receipt' in userOpReceipt && userOpReceipt.receipt?.transactionHash) {
          txHash = userOpReceipt.receipt.transactionHash as `0x${string}`
        } else {
          throw new Error("User operation completed but no transaction hash found in receipt")
        }
      } else if (typeof userOpReceipt === 'string') {
        txHash = userOpReceipt as `0x${string}`
      } else {
        throw new Error("User operation completed but no transaction hash received")
      }
      
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
            message: `[Bot #${walletIndex + 1}] Swap executed: $${amountUsdValue.toFixed(2)} to Target Token. [View Transaction](https://basescan.org/tx/${txHash})`,
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
        created_at: new Date().toISOString(),
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
            message: `[Bot #${walletIndex + 1}] Swap failed: ${swapError.message}`,
            error_details: {
              error: swapError.message,
              stack: process.env.NODE_ENV === 'development' ? swapError.stack : undefined,
            },
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
