#!/usr/bin/env node
/**
 * FarBump Bumping Worker
 * 
 * Background worker untuk menjalankan bumping bot secara otomatis
 * di Railway/VPS meskipun aplikasi ditutup.
 * 
 * Cara menjalankan:
 *   npm install -g ts-node typescript
 *   ts-node server/bumping-worker.ts
 * 
 * Atau compile dulu:
 *   tsc server/bumping-worker.ts
 *   node server/bumping-worker.js
 * 
 * Environment Variables Required:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - CDP_API_KEY_NAME
 *   - CDP_PRIVATE_KEY
 *   - ZEROX_API_KEY
 *   - NEXT_PUBLIC_BASE_RPC_URL
 */

import { createClient } from "@supabase/supabase-js"
import { CdpClient } from "@coinbase/cdp-sdk"
import { createPublicClient, http, formatEther, parseEther, isAddress, type Address, type Hex, encodeFunctionData, readContract } from "viem"
import { base } from "viem/chains"
import "dotenv/config"

// ============================================
// Configuration
// ============================================

const POLLING_INTERVAL_MS = 30 * 1000 // 30 detik
const BATCH_UPDATE_INTERVAL_MS = 60 * 1000 // 60 detik
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

// WETH ABI
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

// ============================================
// Initialize Clients
// ============================================

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing Supabase environment variables")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// Initialize CDP Client using Environment Variables
// IMPORTANT: Use environment variables only, do NOT read from file
// Use CDP_API_KEY_NAME and CDP_API_KEY_PRIVATE_KEY (or CDP_PRIVATE_KEY as fallback)
const cdpApiKeyName = process.env.CDP_API_KEY_NAME
const cdpPrivateKey = process.env.CDP_API_KEY_PRIVATE_KEY || process.env.CDP_PRIVATE_KEY

if (!cdpApiKeyName || !cdpPrivateKey) {
  console.error("❌ Missing CDP environment variables")
  console.error("   Required: CDP_API_KEY_NAME and CDP_API_KEY_PRIVATE_KEY (or CDP_PRIVATE_KEY)")
  process.exit(1)
}

CdpClient.configure({
  apiKeyName: cdpApiKeyName,
  privateKey: cdpPrivateKey,
})

console.log("✅ CDP Client configured from environment variables")

const cdp = new CdpClient()

// Initialize Public Client for Base network
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

// ============================================
// Types
// ============================================

interface ActiveSession {
  id: string
  user_address: string
  token_address: string
  amount_usd: string
  interval_seconds: number
  wallet_rotation_index: number
}

interface UserSwapState {
  session: ActiveSession
  lastSwapTime: number
  timeoutId: NodeJS.Timeout | null
  consumedWethWei: bigint // Accumulated WETH consumed (for batch update)
}

// ============================================
// Global State
// ============================================

// Map: user_address -> UserSwapState
const activeUsers = new Map<string, UserSwapState>()

// Map: user_address -> accumulated WETH consumed (for batch update)
const pendingWethUpdates = new Map<string, bigint>()

// ============================================
// Helper Functions
// ============================================

/**
 * Fetch ETH price in USD from CoinGecko
 */
async function getEthPriceUsd(): Promise<number> {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
    const data = await response.json()
    return data.ethereum?.usd || 3000 // Fallback to $3000
  } catch (error) {
    console.warn("⚠️ Failed to fetch ETH price, using fallback $3000")
    return 3000
  }
}

/**
 * Get WETH balance for a bot wallet from database
 */
async function getBotWalletWethBalance(userAddress: string, botWalletAddress: string): Promise<bigint> {
  try {
    const { data, error } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei, distributed_amount_wei")
      .eq("user_address", userAddress.toLowerCase())
      .eq("bot_wallet_address", botWalletAddress.toLowerCase())
      .order("created_at", { ascending: false })

    if (error) {
      console.error(`❌ Error fetching WETH balance for ${botWalletAddress}:`, error)
      return BigInt(0)
    }

    if (!data || data.length === 0) {
      return BigInt(0)
    }

    // Sum all records for this bot wallet (grouped by bot_wallet_address)
    const totalBalance = data.reduce((sum, record) => {
      const amountWei = BigInt(record.weth_balance_wei || record.distributed_amount_wei || "0")
      return sum + amountWei
    }, BigInt(0))

    return totalBalance
  } catch (error: any) {
    console.error(`❌ Error in getBotWalletWethBalance:`, error.message)
    return BigInt(0)
  }
}

/**
 * Get bot wallets for a user
 * Fetches from wallets_data table which stores bot smart accounts
 */
async function getBotWallets(userAddress: string): Promise<Array<{ smartWalletAddress: string; ownerAddress: string }>> {
  try {
    // Fetch all bot wallets for this user
    // Note: wallets_data table may have multiple records or a single record with array
    const { data: walletsData, error } = await supabase
      .from("wallets_data")
      .select("smart_account_address, owner_address")
      .eq("user_address", userAddress.toLowerCase())
      .order("created_at", { ascending: true })

    if (error) {
      console.error(`❌ Error fetching bot wallets for ${userAddress}:`, error)
      return []
    }

    if (!walletsData || walletsData.length === 0) {
      return []
    }

    // Return array of bot wallets
    // Each record in wallets_data represents one bot wallet
    return walletsData
      .filter((wallet: any) => wallet.smart_account_address && wallet.owner_address)
      .map((wallet: any) => ({
        smartWalletAddress: wallet.smart_account_address,
        ownerAddress: wallet.owner_address,
      }))
  } catch (error: any) {
    console.error(`❌ Error in getBotWallets:`, error.message)
    return []
  }
}

/**
 * Execute swap using 0x API and CDP Smart Account
 */
async function executeSwap(
  userAddress: string,
  session: ActiveSession,
  botWalletAddress: string,
  ownerAddress: string,
  amountWei: bigint
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    console.log(`\n🔄 [${userAddress.substring(0, 10)}...] Executing swap...`)
    console.log(`   Bot Wallet: ${botWalletAddress.substring(0, 10)}...`)
    console.log(`   Amount: ${formatEther(amountWei)} WETH`)
    console.log(`   Target Token: ${session.token_address}`)

    // Step 1: Get 0x API quote with retry logic
    const zeroXApiKey = process.env.ZEROX_API_KEY
    if (!zeroXApiKey) {
      throw new Error("ZEROX_API_KEY not configured")
    }

    let quote: any = null
    let quoteError: any = null
    const maxAttempts = 2

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const slippageBps = attempt === 1 ? "500" : "1000" // 5% or 10%

      const quoteParams = new URLSearchParams({
        chainId: "8453",
        sellToken: WETH_ADDRESS.toLowerCase(),
        buyToken: session.token_address.toLowerCase(),
        sellAmount: amountWei.toString(),
        taker: botWalletAddress.toLowerCase(),
        slippageBps,
      })

      const quoteUrl = `https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`
      
      const quoteResponse = await fetch(quoteUrl, {
        headers: {
          "0x-api-key": zeroXApiKey,
          "0x-version": "v2",
          "Accept": "application/json",
        },
      })

      if (!quoteResponse.ok) {
        try {
          quoteError = await quoteResponse.json()
        } catch (e) {
          quoteError = { message: quoteResponse.statusText }
        }

        // Retry with higher slippage if "no Route matched"
        if (quoteError.message && 
            (quoteError.message.includes("no Route matched") || 
             quoteError.message.includes("No route found") ||
             quoteError.message.includes("INSUFFICIENT_ASSET_LIQUIDITY")) &&
            attempt < maxAttempts) {
          console.log(`   ⚠️ Attempt ${attempt} failed, retrying with higher slippage...`)
          continue
        } else {
          throw new Error(`0x API error: ${quoteError.message || quoteResponse.statusText}`)
        }
      } else {
        quote = await quoteResponse.json()
        break
      }
    }

    if (!quote) {
      throw new Error(`0x API error: ${quoteError?.message || "Failed to get quote"}`)
    }

    const transaction = quote.transaction || quote

    if (!transaction.to || !transaction.data) {
      throw new Error("Invalid quote response: missing transaction.to or transaction.data")
    }

    // Step 2: Check WETH allowance for 0x AllowanceHolder
    // In v2 API, the AllowanceHolder contract address is returned in quote.allowanceTarget
    const allowanceTarget = quote.allowanceTarget || transaction.to
    
    if (!allowanceTarget) {
      throw new Error("No allowance target found in quote response")
    }

    const currentAllowance = await readContract(publicClient, {
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "allowance",
      args: [botWalletAddress as Address, allowanceTarget as Address],
    }) as bigint

    if (currentAllowance < amountWei) {
      // Approve WETH to AllowanceHolder
      console.log(`   🔐 Approving WETH to AllowanceHolder (${allowanceTarget.substring(0, 10)}...)...`)
      
      const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
      if (!ownerAccount) {
        throw new Error("Failed to get Owner Account from CDP")
      }

      const smartAccount = await cdp.evm.getSmartAccount({
        owner: ownerAccount,
        address: botWalletAddress,
      })
      if (!smartAccount) {
        throw new Error("Failed to get Smart Account from CDP")
      }

      // Approve max amount to avoid repeated approvals
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
      const approveData = encodeFunctionData({
        abi: WETH_ABI,
        functionName: "approve",
        args: [allowanceTarget as Address, maxApproval],
      })

      const approveCall = {
        to: WETH_ADDRESS,
        data: approveData,
        value: BigInt(0),
      }

      const approveUserOpHash = await (smartAccount as any).sendUserOperation({
        network: "base",
        calls: [approveCall],
        isSponsored: true,
      })

      const approveUserOpHashStr = typeof approveUserOpHash === 'string'
        ? approveUserOpHash
        : (approveUserOpHash?.hash || approveUserOpHash?.userOpHash || String(approveUserOpHash))

      await (smartAccount as any).waitForUserOperation({
        userOpHash: approveUserOpHashStr,
        network: "base",
      })
      console.log(`   ✅ WETH approved to AllowanceHolder`)
    } else {
      console.log(`   ✅ Sufficient WETH allowance (${formatEther(currentAllowance)} WETH)`)
    }

    // Step 3: Execute swap
    console.log(`   🚀 Executing swap transaction...`)
    const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
    if (!ownerAccount) {
      throw new Error("Failed to get Owner Account from CDP")
    }

    const smartAccount = await cdp.evm.getSmartAccount({
      owner: ownerAccount,
      address: botWalletAddress,
    })
    if (!smartAccount) {
      throw new Error("Failed to get Smart Account from CDP")
    }

    const swapCall = {
      to: transaction.to as Address,
      data: transaction.data as Hex,
      value: BigInt(0), // WETH swap, value is 0
    }

    const userOpHash = await (smartAccount as any).sendUserOperation({
      network: "base",
      calls: [swapCall],
      isSponsored: true,
    })

    const userOpHashStr = typeof userOpHash === 'string'
      ? userOpHash
      : (userOpHash?.hash || userOpHash?.userOpHash || String(userOpHash))

    const userOpReceipt = await (smartAccount as any).waitForUserOperation({
      userOpHash: userOpHashStr,
      network: "base",
    })

    // Extract transaction hash
    let txHash: string | null = null
    if (userOpReceipt && typeof userOpReceipt === 'object') {
      txHash = userOpReceipt.transactionHash || userOpReceipt.hash || userOpReceipt.userOpHash || null
    } else if (typeof userOpReceipt === 'string') {
      txHash = userOpReceipt
    }

    if (!txHash) {
      txHash = userOpHashStr // Fallback to userOpHash
    }

    console.log(`   ✅ Swap executed: ${txHash}`)

    // Log to bot_logs
    await supabase.from("bot_logs").insert({
      user_address: userAddress.toLowerCase(),
      wallet_address: botWalletAddress,
      token_address: session.token_address,
      amount_wei: amountWei.toString(),
      action: "swap_executed",
      message: `[Worker] Swap executed: ${formatEther(amountWei)} WETH to Target Token`,
      status: "success",
      tx_hash: txHash,
      created_at: new Date().toISOString(),
    })

    return { success: true, txHash }
  } catch (error: any) {
    console.error(`   ❌ Swap failed:`, error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Process swap for a single user
 */
async function processUserSwap(userState: UserSwapState): Promise<void> {
  const { session, consumedWethWei } = userState
  const userAddress = session.user_address

  try {
    // Get bot wallets
    const botWallets = await getBotWallets(userAddress)
    if (botWallets.length === 0) {
      console.warn(`⚠️ [${userAddress.substring(0, 10)}...] No bot wallets found`)
      await deactivateUser(userAddress, "No bot wallets found")
      return
    }

    // Get current wallet (round-robin)
    const walletIndex = session.wallet_rotation_index % botWallets.length
    const currentWallet = botWallets[walletIndex]

    // Get ETH price and calculate amount
    const ethPriceUsd = await getEthPriceUsd()
    const amountUsdValue = parseFloat(session.amount_usd)
    const amountEthValue = amountUsdValue / ethPriceUsd
    const amountWei = BigInt(Math.floor(amountEthValue * 1e18))

    // Check WETH balance
    const wethBalance = await getBotWalletWethBalance(userAddress, currentWallet.smartWalletAddress)
    
    if (wethBalance < amountWei) {
      console.warn(`⚠️ [${userAddress.substring(0, 10)}...] Insufficient WETH balance`)
      console.warn(`   Required: ${formatEther(amountWei)} WETH`)
      console.warn(`   Available: ${formatEther(wethBalance)} WETH`)
      
      // Try next wallet
      const nextIndex = (walletIndex + 1) % botWallets.length
      if (nextIndex === 0) {
        // All wallets depleted
        await deactivateUser(userAddress, "All bot wallets have insufficient WETH balance")
        return
      }

      // Update rotation index and retry
      await supabase
        .from("bot_sessions")
        .update({ wallet_rotation_index: nextIndex })
        .eq("id", session.id)

      // Retry with next wallet (recursive call after delay)
      setTimeout(() => processUserSwap(userState), 5000)
      return
    }

    // Execute swap
    const result = await executeSwap(
      userAddress,
      session,
      currentWallet.smartWalletAddress,
      currentWallet.ownerAddress,
      amountWei
    )

    if (result.success) {
      // Accumulate consumed WETH for batch update
      const currentPending = pendingWethUpdates.get(userAddress) || BigInt(0)
      pendingWethUpdates.set(userAddress, currentPending + amountWei)

      // Update userState consumed amount
      userState.consumedWethWei = userState.consumedWethWei + amountWei

      // Update rotation index
      const nextIndex = (walletIndex + 1) % botWallets.length
      await supabase
        .from("bot_sessions")
        .update({ wallet_rotation_index: nextIndex })
        .eq("id", session.id)

      // Update session in userState
      userState.session.wallet_rotation_index = nextIndex

      console.log(`✅ [${userAddress.substring(0, 10)}...] Swap successful`)
    } else {
      console.error(`❌ [${userAddress.substring(0, 10)}...] Swap failed: ${result.error}`)
      
      // Try next wallet on error
      const nextIndex = (walletIndex + 1) % botWallets.length
      await supabase
        .from("bot_sessions")
        .update({ wallet_rotation_index: nextIndex })
        .eq("id", session.id)

      // Update session in userState
      userState.session.wallet_rotation_index = nextIndex
    }

    // Schedule next swap
    scheduleNextSwap(userState)
  } catch (error: any) {
    console.error(`❌ [${userAddress.substring(0, 10)}...] Error in processUserSwap:`, error.message)
    // Schedule next swap even on error (with delay)
    setTimeout(() => scheduleNextSwap(userState), 10000)
  }
}

/**
 * Schedule next swap for a user
 */
function scheduleNextSwap(userState: UserSwapState): void {
  const { session } = userState
  const intervalMs = session.interval_seconds * 1000

  // Clear existing timeout
  if (userState.timeoutId) {
    clearTimeout(userState.timeoutId)
  }

  // Schedule next swap
  userState.timeoutId = setTimeout(() => {
    userState.lastSwapTime = Date.now()
    processUserSwap(userState)
  }, intervalMs)

  console.log(`⏱️ [${session.user_address.substring(0, 10)}...] Next swap in ${session.interval_seconds}s`)
}

/**
 * Deactivate user (set is_active = false)
 */
async function deactivateUser(userAddress: string, reason: string): Promise<void> {
  console.log(`🛑 [${userAddress.substring(0, 10)}...] Deactivating user: ${reason}`)

  // Clear timeout
  const userState = activeUsers.get(userAddress)
  if (userState?.timeoutId) {
    clearTimeout(userState.timeoutId)
  }

  // Remove from active users
  activeUsers.delete(userAddress)

  // Update database
  await supabase
    .from("bot_sessions")
    .update({ status: "stopped" })
    .eq("user_address", userAddress.toLowerCase())
    .eq("status", "running")

  // Log deactivation
  await supabase.from("bot_logs").insert({
    user_address: userAddress.toLowerCase(),
    wallet_address: "",
    token_address: "",
    amount_wei: "0",
    action: "session_stopped",
    message: `[Worker] Session stopped: ${reason}`,
    status: "info",
    created_at: new Date().toISOString(),
  })
}

/**
 * Batch update WETH balances to Supabase
 * Consumes credit from bot_wallet_credits table based on accumulated WETH consumed
 */
async function batchUpdateWethBalances(): Promise<void> {
  if (pendingWethUpdates.size === 0) {
    return
  }

  console.log(`\n💰 Batch updating WETH balances for ${pendingWethUpdates.size} users...`)

  for (const [userAddress, totalConsumedWethWei] of pendingWethUpdates.entries()) {
    try {
      if (totalConsumedWethWei <= BigInt(0)) {
        continue
      }

      // Get all bot wallets for this user
      const botWallets = await getBotWallets(userAddress)
      
      // Distribute consumed amount across all bot wallets (proportional to their balance)
      // Or consume from wallets in rotation order
      let remainingToConsume = totalConsumedWethWei

      for (const botWallet of botWallets) {
        if (remainingToConsume <= BigInt(0)) break

        // Get all credit records for this bot wallet
        const { data: creditRecords } = await supabase
          .from("bot_wallet_credits")
          .select("id, weth_balance_wei, distributed_amount_wei")
          .eq("user_address", userAddress.toLowerCase())
          .eq("bot_wallet_address", botWallet.smartWalletAddress.toLowerCase())
          .order("created_at", { ascending: false })

        if (!creditRecords || creditRecords.length === 0) {
          continue
        }

        // Consume from most recent records first (FIFO)
        for (const record of creditRecords) {
          if (remainingToConsume <= BigInt(0)) break

          const recordBalance = BigInt(record.weth_balance_wei || record.distributed_amount_wei || "0")
          if (recordBalance > BigInt(0)) {
            const consumeAmount = remainingToConsume < recordBalance ? remainingToConsume : recordBalance
            const newBalance = recordBalance - consumeAmount

            await supabase
              .from("bot_wallet_credits")
              .update({ 
                weth_balance_wei: newBalance.toString(),
                distributed_amount_wei: newBalance.toString(), // Also update for backward compatibility
              })
              .eq("id", record.id)

            remainingToConsume = remainingToConsume - consumeAmount
          }
        }
      }

      if (remainingToConsume > BigInt(0)) {
        console.warn(`   ⚠️ Could not consume full amount for ${userAddress.substring(0, 10)}... Remaining: ${formatEther(remainingToConsume)} WETH`)
      } else {
        console.log(`   ✅ Updated WETH balance for ${userAddress.substring(0, 10)}... (consumed: ${formatEther(totalConsumedWethWei)} WETH)`)
      }
    } catch (error: any) {
      console.error(`   ❌ Error updating WETH balance for ${userAddress}:`, error.message)
    }
  }

  // Clear pending updates
  pendingWethUpdates.clear()
  console.log(`✅ Batch update complete\n`)
}

/**
 * Poll database for active sessions
 */
async function pollActiveSessions(): Promise<void> {
  try {
    console.log(`\n🔍 Polling active sessions...`)

    const { data: sessions, error } = await supabase
      .from("bot_sessions")
      .select("id, user_address, token_address, amount_usd, interval_seconds, wallet_rotation_index")
      .eq("status", "running")

    if (error) {
      console.error("❌ Error polling sessions:", error)
      return
    }

    if (!sessions || sessions.length === 0) {
      console.log("   ℹ️ No active sessions found")
      return
    }

    console.log(`   ✅ Found ${sessions.length} active session(s)`)

    // Update active users map
    const currentUserAddresses = new Set<string>()

    for (const session of sessions) {
      const userAddress = session.user_address.toLowerCase()
      currentUserAddresses.add(userAddress)

      // If user is not in activeUsers, add them
      if (!activeUsers.has(userAddress)) {
        console.log(`   ➕ Adding user: ${userAddress.substring(0, 10)}...`)
        
        const userState: UserSwapState = {
          session: session as ActiveSession,
          lastSwapTime: 0,
          timeoutId: null,
          consumedWethWei: BigInt(0),
        }

        activeUsers.set(userAddress, userState)
        
        // Start swap loop immediately
        processUserSwap(userState)
      } else {
        // Update session data if changed
        const userState = activeUsers.get(userAddress)!
        if (userState.session.id !== session.id) {
          userState.session = session as ActiveSession
        }
      }
    }

    // Remove users that are no longer active
    for (const [userAddress, userState] of activeUsers.entries()) {
      if (!currentUserAddresses.has(userAddress)) {
        console.log(`   ➖ Removing user: ${userAddress.substring(0, 10)}...`)
        if (userState.timeoutId) {
          clearTimeout(userState.timeoutId)
        }
        activeUsers.delete(userAddress)
      }
    }

    console.log(`   📊 Active users: ${activeUsers.size}`)
  } catch (error: any) {
    console.error("❌ Error in pollActiveSessions:", error.message)
  }
}

// ============================================
// Main Worker Loop
// ============================================

async function startWorker(): Promise<void> {
  console.log("=".repeat(60))
  console.log("🚀 FarBump Bumping Worker Started")
  console.log("=".repeat(60))
  console.log(`📊 Polling interval: ${POLLING_INTERVAL_MS / 1000}s`)
  console.log(`💰 Batch update interval: ${BATCH_UPDATE_INTERVAL_MS / 1000}s`)
  console.log("=".repeat(60))
  console.log("")

  // Initial poll
  await pollActiveSessions()

  // Poll database every 30 seconds
  setInterval(pollActiveSessions, POLLING_INTERVAL_MS)

  // Batch update WETH balances every 60 seconds
  setInterval(batchUpdateWethBalances, BATCH_UPDATE_INTERVAL_MS)

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n\n🛑 Shutting down worker...")
    
    // Clear all timeouts
    for (const userState of activeUsers.values()) {
      if (userState.timeoutId) {
        clearTimeout(userState.timeoutId)
      }
    }

    // Final batch update
    await batchUpdateWethBalances()

    console.log("✅ Worker stopped gracefully")
    process.exit(0)
  })

  process.on("SIGTERM", async () => {
    console.log("\n\n🛑 Shutting down worker...")
    
    // Clear all timeouts
    for (const userState of activeUsers.values()) {
      if (userState.timeoutId) {
        clearTimeout(userState.timeoutId)
      }
    }

    // Final batch update
    await batchUpdateWethBalances()

    console.log("✅ Worker stopped gracefully")
    process.exit(0)
  })
}

// Start worker
startWorker().catch((error) => {
  console.error("❌ Fatal error starting worker:", error)
  process.exit(1)
})

