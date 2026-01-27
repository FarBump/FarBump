#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js"
// Perubahan: Gunakan Coinbase dari SDK terbaru
import { Coinbase } from "@coinbase/coinbase-sdk"
import { createPublicClient, http, formatEther, parseEther, isAddress, type Address, type Hex, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import "dotenv/config"

// ============================================
// Configuration
// ============================================

const POLLING_INTERVAL_MS = 30 * 1000 
const BATCH_UPDATE_INTERVAL_MS = 60 * 1000 
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

const WETH_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
] as const

// ============================================
// Initialize Clients
// ============================================

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseKey)

const cdpApiKeyName = process.env.CDP_API_KEY_NAME!
const cdpPrivateKey = process.env.CDP_API_KEY_PRIVATE_KEY!

try {
  const privateKeyFormatted = cdpPrivateKey.replace(/\\n/g, '\n')
  
  // FIX: Menggunakan Coinbase.configure (V2 SDK)
  Coinbase.configure({
    apiKeyName: cdpApiKeyName,
    privateKey: privateKeyFormatted,
  })
  
  console.log("✅ CDP Client configured successfully")
} catch (error: any) {
  console.error("❌ Failed to configure CDP Client:", error.message)
  process.exit(1)
}

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

// ============================================
// Types & State
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
  consumedWethWei: bigint 
}

const activeUsers = new Map<string, UserSwapState>()
const pendingWethUpdates = new Map<string, bigint>()

// ============================================
// Helper Functions (FIXED)
// ============================================

async function getEthPriceUsd(): Promise<number> {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
    const data = await response.json()
    return data.ethereum?.usd || 3000
  } catch { return 3000 }
}

async function getBotWalletWethBalance(userAddress: string, botWalletAddress: string): Promise<bigint> {
    const { data, error } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei")
      .eq("user_address", userAddress.toLowerCase())
      .eq("bot_wallet_address", botWalletAddress.toLowerCase())
      .single()
    
    if (error && error.code !== "PGRST116") {
      console.error(`❌ Error fetching WETH balance for ${botWalletAddress}:`, error)
    }
    
    return BigInt(data?.weth_balance_wei || "0")
}

async function getBotWallets(userAddress: string) {
    const { data, error } = await supabase
      .from("wallets_data")
      .select("smart_account_address, owner_address")
      .eq("user_address", userAddress.toLowerCase())
    
    if (error) {
      console.error(`❌ Error fetching bot wallets for ${userAddress}:`, error)
      return []
    }
    
    return data || []
}

async function deductBotWalletWethBalance(userAddress: string, botWalletAddress: string, amountWei: bigint): Promise<boolean> {
  try {
    // Get current balance
    const currentBalance = await getBotWalletWethBalance(userAddress, botWalletAddress)
    
    if (currentBalance < amountWei) {
      console.warn(`⚠️ Insufficient balance: ${formatEther(currentBalance)} < ${formatEther(amountWei)}`)
      return false
    }
    
    // Calculate new balance
    const newBalance = currentBalance - amountWei
    
    // Update database
    const { error } = await supabase
      .from("bot_wallet_credits")
      .update({ weth_balance_wei: newBalance.toString() })
      .eq("user_address", userAddress.toLowerCase())
      .eq("bot_wallet_address", botWalletAddress.toLowerCase())
    
    if (error) {
      console.error(`❌ Error updating WETH balance for ${botWalletAddress}:`, error)
      return false
    }
    
    console.log(`✅ Deducted ${formatEther(amountWei)} WETH from ${botWalletAddress}`)
    console.log(`   New balance: ${formatEther(newBalance)} WETH`)
    return true
  } catch (error: any) {
    console.error(`❌ Error deducting WETH balance:`, error.message)
    return false
  }
}

async function checkAllWalletsEmpty(userAddress: string): Promise<boolean> {
  try {
    const botWallets = await getBotWallets(userAddress)
    
    if (botWallets.length === 0) {
      console.log(`⚠️ No bot wallets found for ${userAddress}`)
      return true
    }
    
    // Check ETH price for USD calculation
    const ethPriceUsd = await getEthPriceUsd()
    const MIN_BALANCE_USD = 0.01 // Minimum $0.01 USD required
    const minBalanceWei = parseEther((MIN_BALANCE_USD / ethPriceUsd).toString())
    
    let walletsWithSufficientBalance = 0
    
    for (const wallet of botWallets) {
      const balance = await getBotWalletWethBalance(userAddress, wallet.smart_account_address)
      
      if (balance >= minBalanceWei) {
        walletsWithSufficientBalance++
      }
    }
    
    const allEmpty = walletsWithSufficientBalance === 0
    
    if (allEmpty) {
      console.log(`🛑 All ${botWallets.length} bot wallets have insufficient balance (< $${MIN_BALANCE_USD} USD)`)
    }
    
    return allEmpty
  } catch (error: any) {
    console.error(`❌ Error checking wallet balances:`, error.message)
    return false
  }
}

// ============================================
// Execute Swap (MAJOR FIXES)
// ============================================

async function executeSwap(
  userAddress: string,
  session: ActiveSession,
  botWalletAddress: string,
  ownerAddress: string,
  amountWei: bigint
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const zeroXApiKey = process.env.ZEROX_API_KEY!
    
    // Step 1: Get Quote
    const quoteParams = new URLSearchParams({
        chainId: "8453",
        sellToken: WETH_ADDRESS,
        buyToken: session.token_address,
        sellAmount: amountWei.toString(),
        taker: botWalletAddress,
        slippageBps: "1000", // 10% for safety
    })

    const response = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`, {
        headers: { "0x-api-key": zeroXApiKey, "0x-version": "v2" }
    })
    const quote = await response.json()
    if (!response.ok) throw new Error(quote.message || "0x API Error")

    const transaction = quote.transaction
    const allowanceTarget = quote.allowanceTarget || transaction.to

    // Step 2: Check Allowance (FIX: Gunakan publicClient.readContract)
    const currentAllowance = await publicClient.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "allowance",
      args: [botWalletAddress as Address, allowanceTarget as Address],
    })

    const ownerAccount = await Coinbase.evm.getAccount({ address: ownerAddress as Address })
    const smartAccount = await Coinbase.evm.getSmartAccount({
        owner: ownerAccount,
        address: botWalletAddress as Address,
    })

    if (currentAllowance < amountWei) {
      const approveData = encodeFunctionData({
        abi: WETH_ABI,
        functionName: "approve",
        args: [allowanceTarget as Address, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
      })

      const op = await (smartAccount as any).sendUserOperation({
        network: "base",
        calls: [{ to: WETH_ADDRESS, data: approveData, value: 0n }],
        isSponsored: true,
      })
      await (smartAccount as any).waitForUserOperation({ userOpHash: op.hash || op, network: "base" })
    }

    // Step 3: Execute Swap
    const swapOp = await (smartAccount as any).sendUserOperation({
      network: "base",
      calls: [{ to: transaction.to as Address, data: transaction.data as Hex, value: 0n }],
      isSponsored: true,
    })

    const receipt = await (smartAccount as any).waitForUserOperation({ userOpHash: swapOp.hash || swapOp, network: "base" })
    const txHash = receipt.transactionHash || swapOp.hash || String(swapOp)

    // Log to Supabase
    await supabase.from("bot_logs").insert({
      user_address: userAddress.toLowerCase(),
      wallet_address: botWalletAddress,
      token_address: session.token_address,
      amount_wei: amountWei.toString(),
      action: "swap_executed",
      message: `[Worker] Swapped ${formatEther(amountWei)} WETH`,
      status: "success",
      tx_hash: txHash,
    })

    return { success: true, txHash }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ... sisanya (processUserSwap, pollActiveSessions, dll) tetap secara logika, 
// pastikan menggunakan as Address saat memanggil fungsi blockchain.

async function processUserSwap(userState: UserSwapState): Promise<void> {
    const { session } = userState
    const userAddress = session.user_address
  
    try {
      // Check if session is still running
      const { data: currentSession } = await supabase
        .from("bot_sessions")
        .select("status")
        .eq("id", session.id)
        .single()
      
      if (!currentSession || currentSession.status !== "running") {
        console.log(`⏹️ Session stopped for user ${userAddress}`)
        activeUsers.delete(userAddress)
        return
      }
      
      const botWallets = await getBotWallets(userAddress)
      if (botWallets.length === 0) {
        console.error(`❌ No bot wallets found for ${userAddress}`)
        return await deactivateUser(userAddress, "No bot wallets found")
      }
  
      const walletIndex = session.wallet_rotation_index % botWallets.length
      const currentWallet = botWallets[walletIndex]
  
      const ethPriceUsd = await getEthPriceUsd()
      const amountWei = parseEther((parseFloat(session.amount_usd) / ethPriceUsd).toString())
  
      console.log(`\n🔄 [Worker] Processing swap for user ${userAddress}`)
      console.log(`   Wallet #${walletIndex + 1}: ${currentWallet.smart_account_address}`)
      console.log(`   Amount: ${formatEther(amountWei)} WETH ($${session.amount_usd} USD)`)
      
      const wethBalance = await getBotWalletWethBalance(userAddress, currentWallet.smart_account_address)
      console.log(`   Current balance: ${formatEther(wethBalance)} WETH`)
      
      if (wethBalance < amountWei) {
        console.log(`⏭️ Wallet #${walletIndex + 1} has insufficient balance, rotating to next wallet`)
        
        // Check if all wallets are empty before rotating
        const allEmpty = await checkAllWalletsEmpty(userAddress)
        
        if (allEmpty) {
          console.log(`🛑 All bot wallets depleted for user ${userAddress}`)
          await deactivateUser(userAddress, "All bot wallets depleted")
          
          // Log to bot_logs
          await supabase.from("bot_logs").insert({
            user_address: userAddress.toLowerCase(),
            wallet_address: null,
            token_address: session.token_address,
            amount_wei: "0",
            action: "session_stopped",
            message: "[Worker] Session stopped - all bot wallets depleted",
            status: "info",
          })
          
          activeUsers.delete(userAddress)
          return
        }
        
        // Rotate to next wallet
        const nextIndex = (walletIndex + 1) % botWallets.length
        await supabase
          .from("bot_sessions")
          .update({ wallet_rotation_index: nextIndex })
          .eq("id", session.id)
        
        session.wallet_rotation_index = nextIndex
        return scheduleNextSwap(userState)
      }
  
      // Execute swap
      const result = await executeSwap(
        userAddress, 
        session, 
        currentWallet.smart_account_address, 
        currentWallet.owner_address, 
        amountWei
      )
  
      if (result.success) {
        console.log(`✅ Swap successful! TX: ${result.txHash}`)
        
        // Deduct balance immediately
        await deductBotWalletWethBalance(userAddress, currentWallet.smart_account_address, amountWei)
        
        userState.consumedWethWei += amountWei
        
        // Rotate to next wallet
        const nextIndex = (walletIndex + 1) % botWallets.length
        await supabase
          .from("bot_sessions")
          .update({ wallet_rotation_index: nextIndex })
          .eq("id", session.id)
        
        session.wallet_rotation_index = nextIndex
      } else {
        console.error(`❌ Swap failed: ${result.error}`)
        
        // Check if error is due to insufficient balance (execution reverted)
        if (result.error?.includes("execution reverted") || result.error?.includes("insufficient")) {
          // Check if all wallets are depleted
          const allEmpty = await checkAllWalletsEmpty(userAddress)
          
          if (allEmpty) {
            console.log(`🛑 All bot wallets depleted for user ${userAddress}`)
            await deactivateUser(userAddress, "All bot wallets depleted")
            
            await supabase.from("bot_logs").insert({
              user_address: userAddress.toLowerCase(),
              wallet_address: null,
              token_address: session.token_address,
              amount_wei: "0",
              action: "session_stopped",
              message: "[Worker] Session stopped - all bot wallets depleted",
              status: "info",
            })
            
            activeUsers.delete(userAddress)
            return
          }
        }
        
        // Rotate to next wallet on error
        const nextIndex = (walletIndex + 1) % botWallets.length
        await supabase
          .from("bot_sessions")
          .update({ wallet_rotation_index: nextIndex })
          .eq("id", session.id)
        
        session.wallet_rotation_index = nextIndex
      }
  
      // Schedule next swap
      scheduleNextSwap(userState)
    } catch (error: any) {
      console.error(`❌ Error in processUserSwap for ${userAddress}:`, error.message)
      scheduleNextSwap(userState)
    }
}

function scheduleNextSwap(userState: UserSwapState): void {
  if (userState.timeoutId) clearTimeout(userState.timeoutId)
  userState.timeoutId = setTimeout(() => processUserSwap(userState), userState.session.interval_seconds * 1000)
}

async function deactivateUser(userAddress: string, reason: string) {
    try {
      console.log(`🛑 Deactivating user ${userAddress} - Reason: ${reason}`)
      
      const { error } = await supabase
        .from("bot_sessions")
        .update({ 
          status: "stopped",
          stopped_at: new Date().toISOString()
        })
        .eq("user_address", userAddress.toLowerCase())
        .eq("status", "running")
      
      if (error) {
        console.error(`❌ Error deactivating user ${userAddress}:`, error)
      } else {
        console.log(`✅ User ${userAddress} deactivated successfully`)
      }
      
      // Remove from active users
      activeUsers.delete(userAddress)
    } catch (error: any) {
      console.error(`❌ Error in deactivateUser:`, error.message)
    }
}

async function batchUpdateWethBalances() {
    // This function is now deprecated since we update balances immediately after each swap
    // in the deductBotWalletWethBalance() function
    // 
    // Keeping this function for backward compatibility, but it does nothing
    // since pendingWethUpdates is no longer used (we do immediate updates instead)
    
    if (pendingWethUpdates.size > 0) {
      console.log(`⚠️ Warning: pendingWethUpdates has ${pendingWethUpdates.size} entries but should be empty`)
      console.log(`   Balances are now updated immediately after each swap`)
      pendingWethUpdates.clear()
    }
}

async function pollActiveSessions() {
    try {
      const { data: sessions, error } = await supabase
        .from("bot_sessions")
        .select("*")
        .eq("status", "running")
      
      if (error) {
        console.error(`❌ Error polling active sessions:`, error)
        return
      }
      
      if (!sessions || sessions.length === 0) {
        if (activeUsers.size > 0) {
          console.log(`ℹ️ No active sessions found, but ${activeUsers.size} users in memory`)
        }
        return
      }
      
      console.log(`📊 Found ${sessions.length} active session(s)`)
      
      sessions.forEach(session => {
        if (!activeUsers.has(session.user_address)) {
          console.log(`🆕 New active session detected for ${session.user_address}`)
          console.log(`   Token: ${session.token_address}`)
          console.log(`   Amount: $${session.amount_usd} USD`)
          console.log(`   Interval: ${session.interval_seconds}s`)
          
          const state: UserSwapState = { 
            session, 
            lastSwapTime: 0, 
            timeoutId: null, 
            consumedWethWei: 0n 
          }
          activeUsers.set(session.user_address, state)
          
          // Start processing swaps for this user
          processUserSwap(state)
        }
      })
      
      // Clean up users that are no longer running
      for (const [userAddress, state] of activeUsers.entries()) {
        const sessionExists = sessions.some(s => s.user_address === userAddress)
        if (!sessionExists) {
          console.log(`🧹 Cleaning up inactive user: ${userAddress}`)
          if (state.timeoutId) {
            clearTimeout(state.timeoutId)
          }
          activeUsers.delete(userAddress)
        }
      }
    } catch (error: any) {
      console.error(`❌ Error in pollActiveSessions:`, error.message)
    }
}

async function startWorker() {
    console.log("\n=================================================")
    console.log("🚀 FarBump Bumping Worker Started")
    console.log("=================================================")
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`)
    console.log(`⏱️  Polling interval: ${POLLING_INTERVAL_MS / 1000}s`)
    console.log(`💾 Database: ${supabaseUrl}`)
    console.log(`🔗 Chain: Base (8453)`)
    console.log(`🌐 RPC: ${process.env.NEXT_PUBLIC_BASE_RPC_URL}`)
    console.log("=================================================\n")
    
    // Initial poll
    console.log("🔍 Performing initial session poll...")
    await pollActiveSessions()
    
    // Set up polling intervals
    console.log(`✅ Setting up polling (every ${POLLING_INTERVAL_MS / 1000}s)`)
    setInterval(pollActiveSessions, POLLING_INTERVAL_MS)
    
    // Batch update is deprecated but kept for compatibility
    setInterval(batchUpdateWethBalances, BATCH_UPDATE_INTERVAL_MS)
    
    console.log("✅ Worker initialized successfully\n")
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received, cleaning up...')
  
  // Clear all timeouts
  for (const [userAddress, state] of activeUsers.entries()) {
    if (state.timeoutId) {
      clearTimeout(state.timeoutId)
    }
    console.log(`🧹 Cleared timeout for ${userAddress}`)
  }
  
  console.log('✅ Cleanup complete, exiting...')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received, cleaning up...')
  
  // Clear all timeouts
  for (const [userAddress, state] of activeUsers.entries()) {
    if (state.timeoutId) {
      clearTimeout(state.timeoutId)
    }
    console.log(`🧹 Cleared timeout for ${userAddress}`)
  }
  
  console.log('✅ Cleanup complete, exiting...')
  process.exit(0)
})

startWorker().catch(error => {
  console.error('❌ Fatal error starting worker:', error)
  process.exit(1)
})
