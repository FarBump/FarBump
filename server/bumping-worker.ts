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
    const { data } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei")
      .eq("user_address", userAddress.toLowerCase())
      .eq("bot_wallet_address", botWalletAddress.toLowerCase())
      .single()
    return BigInt(data?.weth_balance_wei || "0")
}

async function getBotWallets(userAddress: string) {
    const { data } = await supabase
      .from("wallets_data")
      .select("smart_account_address, owner_address")
      .eq("user_address", userAddress.toLowerCase())
    return data || []
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
      const botWallets = await getBotWallets(userAddress)
      if (botWallets.length === 0) return await deactivateUser(userAddress, "No wallets")
  
      const walletIndex = session.wallet_rotation_index % botWallets.length
      const currentWallet = botWallets[walletIndex]
  
      const ethPriceUsd = await getEthPriceUsd()
      const amountWei = parseEther((parseFloat(session.amount_usd) / ethPriceUsd).toString())
  
      const wethBalance = await getBotWalletWethBalance(userAddress, currentWallet.smart_account_address)
      
      if (wethBalance < amountWei) {
        // Logika rotasi jika saldo habis...
        return scheduleNextSwap(userState)
      }
  
      const result = await executeSwap(
        userAddress, session, currentWallet.smart_account_address, currentWallet.owner_address, amountWei
      )
  
      if (result.success) {
        const currentPending = pendingWethUpdates.get(userAddress) || 0n
        pendingWethUpdates.set(userAddress, currentPending + amountWei)
        userState.consumedWethWei += amountWei
      }
  
      // Update index rotasi
      await supabase.from("bot_sessions").update({ wallet_rotation_index: (walletIndex + 1) }).eq("id", session.id)
      scheduleNextSwap(userState)
    } catch (e) { scheduleNextSwap(userState) }
}

function scheduleNextSwap(userState: UserSwapState): void {
  if (userState.timeoutId) clearTimeout(userState.timeoutId)
  userState.timeoutId = setTimeout(() => processUserSwap(userState), userState.session.interval_seconds * 1000)
}

async function deactivateUser(userAddress: string, reason: string) {
    await supabase.from("bot_sessions").update({ status: "stopped" }).eq("user_address", userAddress.toLowerCase())
}

async function batchUpdateWethBalances() {
    for (const [userAddress, total] of pendingWethUpdates.entries()) {
        // Logika pengurangan saldo WETH di database (bot_wallet_credits)
        // Gunakan rpc supabase atau update manual per baris
    }
    pendingWethUpdates.clear()
}

async function pollActiveSessions() {
    const { data: sessions } = await supabase.from("bot_sessions").select("*").eq("status", "running")
    sessions?.forEach(session => {
        if (!activeUsers.has(session.user_address)) {
            const state = { session, lastSwapTime: 0, timeoutId: null, consumedWethWei: 0n }
            activeUsers.set(session.user_address, state)
            processUserSwap(state)
        }
    })
}

async function startWorker() {
    console.log("🚀 FarBump Bumping Worker Started")
    console.log(`   Polling interval: ${POLLING_INTERVAL_MS / 1000}s`)
    console.log(`   Batch update interval: ${BATCH_UPDATE_INTERVAL_MS / 1000}s`)
    setInterval(pollActiveSessions, POLLING_INTERVAL_MS)
    setInterval(batchUpdateWethBalances, BATCH_UPDATE_INTERVAL_MS)
}

startWorker()
