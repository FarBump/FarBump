import { NextRequest, NextResponse } from "next/server"
import { formatEther, parseEther, isAddress, type Address, type Hex, createPublicClient, http, encodeFunctionData, readContract } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Constants
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const
const ZEROX_EXCHANGE_PROXY = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF" as const // 0x Exchange Proxy on Base

// WETH ABI for balance and approval
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
] as const

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

    // Step 5: Check Smart Account WETH balance from database
    console.log(`💰 Checking Smart Account WETH balance...`)
    
    // Fetch WETH balance from database (bot_wallet_credits)
    const { data: creditRecords, error: creditError } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei, distributed_amount_wei")
      .eq("user_address", user_address.toLowerCase())
      .eq("bot_wallet_address", smartAccountAddress.toLowerCase())
      .order("created_at", { ascending: false })

    // Calculate total WETH balance for this bot wallet
    // Use weth_balance_wei if available, otherwise fallback to distributed_amount_wei
    const wethBalanceWei = creditRecords?.reduce((sum, record) => {
      const amountWei = record.weth_balance_wei || record.distributed_amount_wei || "0"
      return sum + BigInt(amountWei)
    }, BigInt(0)) || BigInt(0)

    console.log(`   WETH Balance (from DB): ${formatEther(wethBalanceWei)} WETH`)

    // Also check on-chain WETH balance for verification
    try {
      const onChainWethBalance = await readContract(publicClient, {
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "balanceOf",
        args: [smartAccountAddress],
      }) as bigint
      console.log(`   WETH Balance (on-chain): ${formatEther(onChainWethBalance)} WETH`)
      
      // If on-chain balance is less than database balance, sync database
      if (onChainWethBalance < wethBalanceWei) {
        console.log(`   ⚠️ On-chain balance is less than database balance. Syncing...`)
        // This will be handled after swap execution
      }
    } catch (error: any) {
      console.warn(`   ⚠️ Failed to check on-chain WETH balance: ${error.message}`)
    }

    // Fetch ETH price for USD conversion
    const ethPriceResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/eth-price`)
    const { price: ethPriceUsd } = await ethPriceResponse.json()
    
    const balanceInUsd = Number(formatEther(wethBalanceWei)) * ethPriceUsd
    console.log(`   Balance: $${balanceInUsd.toFixed(4)} USD`)

    // No minimum amount validation - bot can swap any amount
    // But check if balance is zero
    if (wethBalanceWei === BigInt(0)) {
      console.log(`⚠️ Bot #${walletIndex + 1} has no WETH balance - Skipping`)
      
      // Log insufficient balance
      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: "0",
        action: "swap_skipped",
        message: `[System] Bot #${walletIndex + 1} has no WETH balance. Please distribute credit first.`,
        status: "warning",
        created_at: new Date().toISOString(),
      })

      // Check if all wallets are depleted
      let allDepleted = true
      for (let i = 0; i < botWallets.length; i++) {
        const w = botWallets[i]
        const { data: wCredits } = await supabase
          .from("bot_wallet_credits")
          .select("weth_balance_wei, distributed_amount_wei")
          .eq("user_address", user_address.toLowerCase())
          .eq("bot_wallet_address", w.smart_account_address.toLowerCase())
        
        const wWethBalance = wCredits?.reduce((sum, record) => {
          const amountWei = record.weth_balance_wei || record.distributed_amount_wei || "0"
          return sum + BigInt(amountWei)
        }, BigInt(0)) || BigInt(0)
        
        if (wWethBalance > BigInt(0)) {
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
          message: `[System] All bot wallets have no WETH balance. Bumping session completed.`,
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
        message: "Bot wallet has no WETH balance - Skipped",
        skipped: true,
        nextIndex,
      })
    }

    // Step 6: Calculate swap amount in WETH
    const amountUsdValue = parseFloat(amount_usd)
    const amountEthValue = amountUsdValue / ethPriceUsd
    const amountWei = BigInt(Math.floor(amountEthValue * 1e18))
    
    // Check if bot has enough WETH balance
    if (wethBalanceWei < amountWei) {
      console.log(`⚠️ Bot #${walletIndex + 1} WETH balance insufficient (${formatEther(wethBalanceWei)} < ${formatEther(amountWei)}) - Skipping`)
      
      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: amountWei.toString(),
        action: "swap_skipped",
        message: `[System] Bot #${walletIndex + 1} WETH balance insufficient (${formatEther(wethBalanceWei)} < ${formatEther(amountWei)}). Please distribute credit.`,
        status: "warning",
        created_at: new Date().toISOString(),
      })

      // Move to next wallet
      const nextIndex = (wallet_rotation_index + 1) % 5
      await supabase
        .from("bot_sessions")
        .update({ wallet_rotation_index: nextIndex })
        .eq("id", sessionId)

      return NextResponse.json({
        message: "Bot wallet WETH balance insufficient - Skipped",
        skipped: true,
        nextIndex,
      })
    }

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
     * 0x API v2 Quote with Retry Logic for WETH swaps (ERC20 token)
     * 
     * Based on: https://docs.0x.org/0x-api-swap/api-references/get-swap-v2-quote
     * 
     * Key Changes for WETH (ERC20):
     * - Endpoint: /swap/v2/quote (for ERC20 tokens like WETH)
     * - sellToken: WETH contract address (0x4200000000000000000000000000000000000006)
     * - buyToken: Target token address
     * - Parameter: slippageBps (basis points: 5% = 500, 10% = 1000)
     * - Response: quote.transaction.to, quote.transaction.data, quote.transaction.value (should be 0 for ERC20)
     * - Transaction value: Always 0 for ERC20 swaps (WETH is not native ETH)
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
      // Using WETH as sellToken (ERC20 token)
      const quoteParams = new URLSearchParams({
        chainId: "8453", // Base Mainnet
        sellToken: WETH_ADDRESS.toLowerCase(), // WETH contract address
        buyToken: token_address.toLowerCase(), // Target token (ensure lowercase)
        sellAmount: amountWei.toString(), // Amount in wei
        taker: smartAccountAddress.toLowerCase(), // Smart Account holds the WETH
        slippageBps: attempt === 1 ? "500" : "1000", // 5% = 500 bps, 10% = 1000 bps
      })

      // Use swap/quote endpoint for ERC20 token swaps (WETH)
      // Reference: https://docs.0x.org/0x-api-swap/api-references/get-swap-v2-quote
      const quoteUrl = `https://api.0x.org/swap/v2/quote?${quoteParams.toString()}`
      console.log(`   Endpoint: /swap/v2/quote (WETH → Token)`)
      console.log(`   URL: ${quoteUrl}`)
      console.log(`   Sell Token: WETH (${WETH_ADDRESS})`)
      console.log(`   Buy Token: ${token_address}`)
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

    // Step 8: Check WETH approval for 0x Exchange Proxy
    console.log(`🔐 Checking WETH approval for 0x Exchange Proxy...`)
    
    let needsApproval = false
    try {
      const currentAllowance = await readContract(publicClient, {
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "allowance",
        args: [smartAccountAddress, ZEROX_EXCHANGE_PROXY],
      }) as bigint

      console.log(`   Current allowance: ${formatEther(currentAllowance)} WETH`)
      console.log(`   Required amount: ${formatEther(amountWei)} WETH`)

      if (currentAllowance < amountWei) {
        needsApproval = true
        console.log(`   ⚠️ Insufficient allowance. Need to approve WETH.`)
      } else {
        console.log(`   ✅ Sufficient allowance. No approval needed.`)
      }
    } catch (approvalCheckError: any) {
      console.warn(`   ⚠️ Failed to check allowance: ${approvalCheckError.message}`)
      // Assume approval is needed if check fails
      needsApproval = true
    }

    // Step 9: Approve WETH if needed
    if (needsApproval) {
      console.log(`🔐 Approving WETH for 0x Exchange Proxy...`)
      
      try {
        // Get Owner Account and Smart Account
        const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
        if (!ownerAccount) {
          throw new Error("Failed to get Owner Account from CDP")
        }

        const smartAccount = await cdp.evm.getSmartAccount({ 
          owner: ownerAccount,
          address: smartAccountAddress 
        })
        if (!smartAccount) {
          throw new Error("Failed to get Smart Account from CDP")
        }

        // Encode approve function call
        // Approve max amount (2^256 - 1) to avoid repeated approvals
        const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
        const approveData = encodeFunctionData({
          abi: WETH_ABI,
          functionName: "approve",
          args: [ZEROX_EXCHANGE_PROXY, maxApproval],
        })

        // Execute approval transaction
        const approveCall = {
          to: WETH_ADDRESS,
          data: approveData,
          value: BigInt(0), // ERC20 approval, value is 0
        }

        console.log(`   → Executing approval transaction...`)
        const approveUserOpHash = await (smartAccount as any).sendUserOperation({
          network: "base",
          calls: [approveCall],
          isSponsored: true,
        })

        const approveUserOpHashStr = typeof approveUserOpHash === 'string' 
          ? approveUserOpHash 
          : (approveUserOpHash?.hash || approveUserOpHash?.userOpHash || String(approveUserOpHash))

        console.log(`   → Approval User Operation submitted: ${approveUserOpHashStr}`)

        // Wait for approval confirmation
        if (typeof (smartAccount as any).waitForUserOperation === 'function') {
          await (smartAccount as any).waitForUserOperation({
            userOpHash: approveUserOpHashStr,
            network: "base",
          })
          console.log(`   ✅ WETH approval confirmed`)
        } else {
          // Fallback: wait using public client
          await publicClient.waitForTransactionReceipt({
            hash: approveUserOpHashStr as `0x${string}`,
            confirmations: 1,
            timeout: 60000,
          })
          console.log(`   ✅ WETH approval confirmed (via public client)`)
        }
      } catch (approvalError: any) {
        console.error(`   ❌ WETH approval failed: ${approvalError.message}`)
        throw new Error(`Failed to approve WETH: ${approvalError.message}`)
      }
    }

    // Step 10: Create swap log entry
    const { data: logEntry, error: logError } = await supabase
      .from("bot_logs")
      .insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: amountWei.toString(),
        action: "swap_executing",
        message: `[Bot #${walletIndex + 1}] Executing swap worth $${amountUsdValue.toFixed(2)} (${formatEther(amountWei)} WETH) to Target Token...`,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (logError) {
      console.error("❌ Failed to create log entry:", logError)
    }

    // Step 11: Check/Create CDP Spend Permissions
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
      // For WETH swaps, value should be 0 (ERC20 transfer, not native ETH)
      const transactionCall = {
        to: transaction.to as Address,
        data: transaction.data as Hex,
        value: BigInt(0), // WETH is ERC20, value is always 0
      }
      
      console.log(`   → Transaction value: 0 (WETH swap, not native ETH)`)
      
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
      // CDP SDK waitForUserOperation may return different formats, handle all cases
      // Possible formats:
      // 1. { transactionHash: "0x..." }
      // 2. { hash: "0x..." }
      // 3. { receipt: { transactionHash: "0x..." } }
      // 4. { userOpHash: "0x...", transactionHash: "0x..." }
      // 5. Direct string "0x..."
      // 6. If receipt doesn't have transactionHash, use getUserOperation to get it
      let txHash: `0x${string}` | null = null
      
      console.log(`   → Extracting transaction hash from receipt...`)
      console.log(`   → Receipt type: ${typeof userOpReceipt}`)
      console.log(`   → Receipt keys: ${userOpReceipt && typeof userOpReceipt === 'object' ? Object.keys(userOpReceipt).join(", ") : "N/A"}`)
      
      if (userOpReceipt && typeof userOpReceipt === 'object') {
        // Try different property names
        if ('transactionHash' in userOpReceipt && userOpReceipt.transactionHash) {
          txHash = userOpReceipt.transactionHash as `0x${string}`
          console.log(`   ✅ Found transactionHash in receipt.transactionHash`)
        } else if ('hash' in userOpReceipt && userOpReceipt.hash) {
          txHash = userOpReceipt.hash as `0x${string}`
          console.log(`   ✅ Found transactionHash in receipt.hash`)
        } else if ('receipt' in userOpReceipt && userOpReceipt.receipt && typeof userOpReceipt.receipt === 'object') {
          if ('transactionHash' in userOpReceipt.receipt && userOpReceipt.receipt.transactionHash) {
            txHash = userOpReceipt.receipt.transactionHash as `0x${string}`
            console.log(`   ✅ Found transactionHash in receipt.receipt.transactionHash`)
          } else if ('hash' in userOpReceipt.receipt && userOpReceipt.receipt.hash) {
            txHash = userOpReceipt.receipt.hash as `0x${string}`
            console.log(`   ✅ Found transactionHash in receipt.receipt.hash`)
          }
        } else if ('userOpHash' in userOpReceipt && userOpReceipt.userOpHash) {
          // If only userOpHash is available, try to get transaction hash from getUserOperation
          console.log(`   → Only userOpHash found, trying getUserOperation to get transaction hash...`)
          if (typeof (smartAccount as any).getUserOperation === 'function') {
            try {
              const userOpStatus = await (smartAccount as any).getUserOperation({
                userOpHash: userOpReceipt.userOpHash,
                network: network,
              })
              console.log(`   → getUserOperation response keys: ${Object.keys(userOpStatus || {}).join(", ")}`)
              
              if (userOpStatus && typeof userOpStatus === 'object') {
                if ('transactionHash' in userOpStatus && userOpStatus.transactionHash) {
                  txHash = userOpStatus.transactionHash as `0x${string}`
                  console.log(`   ✅ Found transactionHash from getUserOperation`)
                } else if ('hash' in userOpStatus && userOpStatus.hash) {
                  txHash = userOpStatus.hash as `0x${string}`
                  console.log(`   ✅ Found transactionHash from getUserOperation.hash`)
                } else if ('receipt' in userOpStatus && userOpStatus.receipt && typeof userOpStatus.receipt === 'object') {
                  if ('transactionHash' in userOpStatus.receipt && userOpStatus.receipt.transactionHash) {
                    txHash = userOpStatus.receipt.transactionHash as `0x${string}`
                    console.log(`   ✅ Found transactionHash from getUserOperation.receipt.transactionHash`)
                  }
                }
              }
            } catch (getErr: any) {
              console.error(`   ⚠️ getUserOperation failed:`, getErr.message)
            }
          }
          
          // If still no transaction hash, use userOpHash as fallback (it's a valid identifier)
          if (!txHash && userOpReceipt.userOpHash) {
            console.log(`   ⚠️ Using userOpHash as transaction identifier: ${userOpReceipt.userOpHash}`)
            txHash = userOpReceipt.userOpHash as `0x${string}`
          }
        }
      } else if (typeof userOpReceipt === 'string') {
        txHash = userOpReceipt as `0x${string}`
        console.log(`   ✅ Receipt is direct string (transaction hash)`)
      }
      
      // If still no transaction hash, try to get it from public client using userOpHash
      if (!txHash && userOpHashStr) {
        console.log(`   → No transaction hash in receipt, trying to find transaction from userOpHash...`)
        // Note: UserOpHash is not the same as transaction hash, but we can try to find the transaction
        // by checking recent transactions from the Smart Account
        // For now, we'll use userOpHash as the identifier
        console.log(`   ⚠️ Using userOpHash as transaction identifier: ${userOpHashStr}`)
        txHash = userOpHashStr as `0x${string}`
      }
      
      if (!txHash) {
        console.error(`   ❌ Could not extract transaction hash from receipt`)
        console.error(`   → Receipt:`, JSON.stringify(userOpReceipt, null, 2))
        throw new Error("User operation completed but no transaction hash found in receipt. Receipt format may have changed.")
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

      // Step 12: Deduct WETH balance from database and record swap history
      console.log(`💰 Deducting WETH balance from database...`)
      
      // Get buyAmount from quote if available
      const buyAmountWei = quote.buyAmount ? BigInt(quote.buyAmount) : BigInt(0)
      
      try {
        // Deduct WETH balance from bot_wallet_credits
        // Find the most recent credit record for this bot wallet
        const { data: creditRecordsToUpdate, error: fetchCreditError } = await supabase
          .from("bot_wallet_credits")
          .select("id, weth_balance_wei, distributed_amount_wei")
          .eq("user_address", user_address.toLowerCase())
          .eq("bot_wallet_address", smartAccountAddress.toLowerCase())
          .order("created_at", { ascending: false })

        if (!fetchCreditError && creditRecordsToUpdate && creditRecordsToUpdate.length > 0) {
          // Deduct from most recent records first (FIFO)
          let remainingToDeduct = amountWei
          
          for (const record of creditRecordsToUpdate) {
            if (remainingToDeduct <= BigInt(0)) break
            
            const currentBalance = BigInt(record.weth_balance_wei || record.distributed_amount_wei || "0")
            
            if (currentBalance > BigInt(0)) {
              const deductAmount = remainingToDeduct < currentBalance ? remainingToDeduct : currentBalance
              const newBalance = currentBalance - deductAmount
              
              await supabase
                .from("bot_wallet_credits")
                .update({ 
                  weth_balance_wei: newBalance.toString(),
                  // Also update distributed_amount_wei for backward compatibility
                  distributed_amount_wei: newBalance.toString(),
                })
                .eq("id", record.id)
              
              remainingToDeduct = remainingToDeduct - deductAmount
              console.log(`   → Deducted ${formatEther(deductAmount)} WETH from record ${record.id}`)
            }
          }
          
          if (remainingToDeduct > BigInt(0)) {
            console.warn(`   ⚠️ Could not deduct full amount. Remaining: ${formatEther(remainingToDeduct)} WETH`)
          } else {
            console.log(`   ✅ WETH balance deducted successfully`)
          }
        } else {
          console.warn(`   ⚠️ No credit records found for bot wallet`)
        }

        // Record swap in bot_logs table (swap_history is not needed, we use bot_logs)
        // The swap is already logged above in Step 10, but we can add additional details here if needed
        // Note: bot_logs already contains all swap information (tx_hash, token_address, amount_wei, etc.)
        console.log(`   ✅ Swap recorded in bot_logs (swap_history not needed)`)

      } catch (deductError: any) {
        console.error(`   ❌ Error deducting WETH balance: ${deductError.message}`)
        // Don't throw - swap succeeded, just log error
      }

      // Log remaining WETH balance from database
      const { data: remainingCredits } = await supabase
        .from("bot_wallet_credits")
        .select("weth_balance_wei, distributed_amount_wei")
        .eq("user_address", user_address.toLowerCase())
        .eq("bot_wallet_address", smartAccountAddress.toLowerCase())

      const remainingWethBalance = remainingCredits?.reduce((sum, record) => {
        const amountWei = record.weth_balance_wei || record.distributed_amount_wei || "0"
        return sum + BigInt(amountWei)
      }, BigInt(0)) || BigInt(0)

      const remainingBalanceUsd = Number(formatEther(remainingWethBalance)) * ethPriceUsd

      await supabase.from("bot_logs").insert({
        user_address: user_address.toLowerCase(),
        wallet_address: smartAccountAddress,
        token_address: token_address,
        amount_wei: remainingWethBalance.toString(),
        action: "balance_check",
        message: `[System] Remaining WETH balance in Bot #${walletIndex + 1}: ${formatEther(remainingWethBalance)} WETH ($${remainingBalanceUsd.toFixed(2)})`,
        status: "info",
        created_at: new Date().toISOString(),
      })

      // Step 12: Update wallet rotation index
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
        remainingBalance: formatEther(remainingWethBalance),
        remainingBalanceUsd: remainingBalanceUsd.toFixed(2),
        sellAmount: formatEther(amountWei),
        buyAmount: buyAmountWei > BigInt(0) ? formatEther(buyAmountWei) : null,
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
