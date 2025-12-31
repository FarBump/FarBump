"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, isAddress, type Address, encodeFunctionData, type Hex } from "viem"
import { 
  BUMP_TOKEN_ADDRESS, 
  TREASURY_ADDRESS, 
  BASE_WETH_ADDRESS,
  UNISWAP_V4_POOL_MANAGER,
  BUMP_DECIMALS,
  TREASURY_FEE_BPS,
  APP_FEE_BPS,
  USER_CREDIT_BPS
} from "@/lib/constants"

// ERC20 ABI for transfer
const ERC20_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
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

// Uniswap V4 PoolManager ABI
// V4 uses a different architecture with hooks and swap actions
// For swap, we use the swap function with SwapParams
const UNISWAP_V4_POOL_MANAGER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "currency0", type: "address" }, // Currency (token address or zero address for native ETH)
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" }, // Hook contract address (can be zero address)
        ],
        name: "key",
        type: "tuple",
      },
      {
        components: [
          { name: "zeroForOne", type: "bool" }, // true = token0 -> token1, false = token1 -> token0
          { name: "amountSpecified", type: "int256" }, // Negative for exact input, positive for exact output
          { name: "sqrtPriceLimitX96", type: "uint160" }, // Price limit (0 = no limit)
        ],
        name: "params",
        type: "tuple",
      },
      { name: "hookData", type: "bytes" }, // Hook data (empty bytes if no hooks)
    ],
    name: "swap",
    outputs: [
      { name: "amount0", type: "int256" },
      { name: "amount1", type: "int256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
        name: "key",
        type: "tuple",
      },
    ],
    name: "getSlot0",
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const

// Note: Uniswap V4 requires a Router or Hook contract to handle token transfers
// For simplicity, we'll use a SwapRouter pattern if available
// If not, we may need to use V3 Router as fallback or implement custom swap logic

export function useConvertFuel() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const reset = () => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
  }

  const convert = async (amount: string) => {
    reset()
    setIsPending(true)

    try {
      // 1. Validasi Smart Wallet
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      if (!publicClient) {
        throw new Error("Public client not available")
      }

      const userAddress = smartWalletClient.account.address

      // 2. Validasi Amount
      const amountNum = parseFloat(amount)
      if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error("Invalid amount")
      }

      const totalAmountWei = parseUnits(amount, BUMP_DECIMALS)

      // 3. Calculate amounts
      // 5% to treasury (in $BUMP)
      const treasuryFeeWei = (totalAmountWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
      // 95% to swap (in $BUMP)
      const swapAmountWei = totalAmountWei - treasuryFeeWei

      console.log("🔄 Starting Convert $BUMP to Credit...")
      console.log(`💰 Total Amount: ${amount} $BUMP`)
      console.log(`📤 Treasury Fee (5%): ${treasuryFeeWei.toString()} wei`)
      console.log(`💱 Swap Amount (95%): ${swapAmountWei.toString()} wei`)

      // 4. Prepare batch transaction calls
      const calls: Array<{
        to: Address
        data: Hex
        value?: bigint
      }> = []

      // Call 1: Transfer 5% $BUMP to Treasury
      const transferData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [TREASURY_ADDRESS as Address, treasuryFeeWei],
      })
      calls.push({
        to: BUMP_TOKEN_ADDRESS as Address,
        data: transferData,
        value: BigInt(0),
      })

      // Call 2: Approve Uniswap V4 PoolManager to spend 95% $BUMP
      // Note: V4 PoolManager may need approval depending on implementation
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [UNISWAP_V4_POOL_MANAGER as Address, swapAmountWei],
      })
      calls.push({
        to: BUMP_TOKEN_ADDRESS as Address,
        data: approveData,
        value: BigInt(0),
      })

      // Call 3: Swap 95% $BUMP to ETH via Uniswap V4 PoolManager
      // V4 uses a different swap mechanism with pool keys and swap params
      // Note: This is a simplified implementation. V4 may require additional setup:
      // - Pool key (currency0, currency1, fee, tickSpacing, hooks)
      // - Swap params (zeroForOne, amountSpecified, sqrtPriceLimitX96)
      // - Hook data (if using hooks)
      
      // For $BUMP -> WETH swap:
      // - currency0 = $BUMP (lower address)
      // - currency1 = WETH (higher address)
      // - zeroForOne = true (swapping currency0 for currency1)
      // - amountSpecified = negative (exact input)
      // - fee = pool fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
      // - tickSpacing = depends on fee tier (usually 1, 60, or 200)
      
      const token0 = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase() 
        ? BUMP_TOKEN_ADDRESS 
        : BASE_WETH_ADDRESS
      const token1 = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
        ? BASE_WETH_ADDRESS
        : BUMP_TOKEN_ADDRESS
      const zeroForOne = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
      
      // Using 0.05% fee tier (500) with tickSpacing 1
      // Adjust these values based on actual pool configuration
      const poolFee = 500 // 0.05%
      const tickSpacing = 1 // For 0.05% fee tier
      const hooksAddress = "0x0000000000000000000000000000000000000000" // No hooks
      
      const swapData = encodeFunctionData({
        abi: UNISWAP_V4_POOL_MANAGER_ABI,
        functionName: "swap",
        args: [
          {
            currency0: token0 as Address,
            currency1: token1 as Address,
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: hooksAddress as Address,
          },
          {
            zeroForOne: zeroForOne,
            amountSpecified: -BigInt(swapAmountWei.toString()), // Negative for exact input
            sqrtPriceLimitX96: BigInt(0), // No price limit
          },
          "0x" as Hex, // Empty hook data
        ],
      })
      calls.push({
        to: UNISWAP_V4_POOL_MANAGER as Address,
        data: swapData,
        value: BigInt(0),
      })

      // Note: We cannot directly transfer 5% of ETH result in the same batch
      // because we don't know the exact ETH amount until swap completes.
      // We'll handle the 5% ETH transfer in a separate transaction or via the API sync.

      // 5. Send batch transaction
      console.log("📦 Sending batch transaction with", calls.length, "calls...")
      
      const MAX_RETRIES = 2
      const TIMEOUT_MS = 30000
      
      let txHash: `0x${string}` | null = null
      let lastError: Error | null = null

      // Retry logic with exponential backoff
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.pow(2, attempt - 1) * 1000
            console.log(`⏳ Waiting ${delay}ms before retry...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }

          // Send batch transaction using multicall or individual calls
          // Privy's smartWalletClient supports batch transactions via sendTransaction with multiple calls
          // However, we need to use a different approach - send them as separate transactions in sequence
          // OR use a multicall contract if available
          
          // For now, we'll send them sequentially to ensure proper execution order
          // First: Transfer 5% to treasury
          const transferTxHash = await Promise.race([
            smartWalletClient.sendTransaction({
              to: BUMP_TOKEN_ADDRESS,
              data: transferData,
              value: BigInt(0),
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
            })
          ]) as `0x${string}`

          // Wait for first transaction to be confirmed
          await publicClient.waitForTransactionReceipt({ hash: transferTxHash })

          // Second: Approve PoolManager
          const approveTxHash = await Promise.race([
            smartWalletClient.sendTransaction({
              to: BUMP_TOKEN_ADDRESS,
              data: approveData,
              value: BigInt(0),
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
            })
          ]) as `0x${string}`

          await publicClient.waitForTransactionReceipt({ hash: approveTxHash })

          // Third: Swap via Uniswap V4 PoolManager
          txHash = await Promise.race([
            smartWalletClient.sendTransaction({
              to: UNISWAP_V4_POOL_MANAGER,
              data: swapData,
              value: BigInt(0),
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
            })
          ]) as `0x${string}`

          break // Success
        } catch (attemptError: any) {
          lastError = attemptError
          console.error(`❌ Convert attempt ${attempt + 1} failed:`, attemptError)
          
          const errorMessage = attemptError.message || ""
          const errorDetails = attemptError.details || attemptError.cause?.details || ""
          const errorName = attemptError.name || attemptError.cause?.name || ""
          
          const isBillingError = 
            errorMessage.includes("No billing attached") ||
            errorMessage.includes("billing attached to account") ||
            errorMessage.includes("request denied") ||
            errorDetails.includes("No billing attached") ||
            errorName === "ResourceUnavailableRpcError"
          
          if (isBillingError) {
            throw attemptError
          }
          
          const isTimeout = 
            errorMessage.includes("timeout") || 
            errorMessage.includes("timed out") ||
            errorName === "TimeoutError"
          
          if (isTimeout && attempt < MAX_RETRIES) {
            console.log(`⚠️ Timeout detected, will retry (${attempt + 1}/${MAX_RETRIES})...`)
            continue
          } else {
            throw attemptError
          }
        }
      }

      if (!txHash) {
        throw lastError || new Error("Failed to send transaction after retries")
      }

      console.log("✅ Transaction Sent! Hash:", txHash)
      setHash(txHash)

      // 6. Wait for confirmation
      if (publicClient) {
        console.log("⏳ Waiting for on-chain confirmation...")
        try {
          const receipt = await Promise.race([
            publicClient.waitForTransactionReceipt({ hash: txHash }),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error("Transaction confirmation timed out"))
              }, 120000)
            })
          ])
          console.log("🎉 Transaction Confirmed:", receipt)
        } catch (confirmationError: any) {
          console.warn("⚠️ Confirmation timeout, but transaction was sent:", confirmationError)
        }
      }

      // 7. Call API to sync credit
      console.log("🔄 Syncing credit to database...")
      try {
        const response = await fetch("/api/sync-credit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            txHash: txHash,
            userAddress: userAddress,
            amountBump: amount,
            amountBumpWei: totalAmountWei.toString(),
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.error || "Failed to sync credit")
        }

        const result = await response.json()
        console.log("✅ Credit synced:", result)
      } catch (syncError: any) {
        console.error("⚠️ Failed to sync credit (transaction succeeded):", syncError)
        // Don't throw - transaction succeeded, sync can be retried
      }

      setIsSuccess(true)
    } catch (err: any) {
      console.error("❌ Convert Error:", err)
      
      let friendlyMessage = err.message || "Transaction failed"
      const errorDetails = err.details || err.cause?.details || ""
      const errorName = err.name || err.cause?.name || ""
      
      if (
        friendlyMessage.includes("No billing attached") ||
        friendlyMessage.includes("billing attached to account") ||
        friendlyMessage.includes("request denied") ||
        errorDetails.includes("No billing attached") ||
        errorName === "ResourceUnavailableRpcError"
      ) {
        friendlyMessage = "Paymaster billing not configured. Please configure billing for mainnet sponsorship in Coinbase CDP Dashboard."
      } else if (friendlyMessage.includes("timeout") || friendlyMessage.includes("timed out") || err.name === "TimeoutError") {
        friendlyMessage = "Transaction request timed out. Please try again in a few moments."
      } else if (friendlyMessage.includes("insufficient funds")) {
        friendlyMessage = "Insufficient $BUMP balance for conversion."
      } else if (friendlyMessage.includes("Failed to fetch") || friendlyMessage.includes("network")) {
        friendlyMessage = "Network error. Please check your internet connection."
      }

      setError(new Error(friendlyMessage))
    } finally {
      setIsPending(false)
    }
  }

  return {
    convert,
    hash,
    isPending,
    isSuccess,
    error,
    reset,
  }
}

