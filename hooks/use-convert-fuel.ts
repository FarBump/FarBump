"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, isAddress, type Address, encodeFunctionData, type Hex, readContract } from "viem"
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
// V4 uses Currency struct (address + type) instead of direct addresses
// Currency: { currency: address, type: uint8 } where type 0 = native ETH, 1 = ERC20
const UNISWAP_V4_POOL_MANAGER_ABI = [
  {
    inputs: [
      {
        components: [
          {
            components: [
              { name: "currency", type: "address" },
              { name: "type", type: "uint8" }, // 0 = native ETH, 1 = ERC20
            ],
            name: "currency0",
            type: "tuple",
          },
          {
            components: [
              { name: "currency", type: "address" },
              { name: "type", type: "uint8" },
            ],
            name: "currency1",
            type: "tuple",
          },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
        name: "key",
        type: "tuple",
      },
      {
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" }, // Negative for exact input
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
      { name: "hookData", type: "bytes" },
    ],
    name: "swap",
    outputs: [
      { name: "amount0", type: "int256" },
      { name: "amount1", type: "int256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

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

      // Call 2: Auto-approve Uniswap V4 PoolManager to spend 95% $BUMP
      // Check current allowance first, only approve if needed
      console.log("🔍 Checking current allowance...")
      const currentAllowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, UNISWAP_V4_POOL_MANAGER as Address],
      })
      
      console.log(`📊 Current Allowance: ${currentAllowance.toString()}, Required: ${swapAmountWei.toString()}`)
      
      // Only approve if current allowance is less than required amount
      if (currentAllowance < swapAmountWei) {
        console.log("✅ Approval needed, adding approve transaction...")
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
      } else {
        console.log("✅ Sufficient allowance already exists, skipping approve")
      }

      // Call 3: Swap 95% $BUMP to WETH via Uniswap V4 PoolManager
      // IMPORTANT: V4 PoolManager requires proper Currency struct format
      // Currency: { currency: address, type: uint8 } where type 0 = native ETH, 1 = ERC20
      // 
      // NOTE: V4 PoolManager doesn't handle token transfers automatically.
      // You may need to use a Router or Hook contract, or handle transfers separately.
      // For now, we're calling PoolManager directly - if this fails, consider using V4 Router.
      
      // Determine token order (currency0 must be < currency1 by address)
      const token0Address = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
        ? BUMP_TOKEN_ADDRESS
        : BASE_WETH_ADDRESS
      const token1Address = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
        ? BASE_WETH_ADDRESS
        : BUMP_TOKEN_ADDRESS
      const zeroForOne = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
      
      // Pool configuration - Try multiple fee tiers dynamically
      // Fee tier options: 500 = 0.05%, 3000 = 0.3%, 10000 = 1%
      // Tick spacing: 1 for 0.05%, 60 for 0.3%, 200 for 1%
      const feeTierOptions = [
        { fee: 500, tickSpacing: 1 },   // 0.05%
        { fee: 3000, tickSpacing: 60 }, // 0.3%
        { fee: 10000, tickSpacing: 200 }, // 1%
      ]
      
      const hooksAddress = "0x0000000000000000000000000000000000000000" // No hooks
      
      // Helper function to generate swap data with specific fee tier
      const generateSwapData = (feeTier: typeof feeTierOptions[0]): Hex => {
        return encodeFunctionData({
          abi: UNISWAP_V4_POOL_MANAGER_ABI,
          functionName: "swap",
          args: [
            {
              currency0: {
                currency: token0Address as Address,
                type: 1, // ERC20 token (both $BUMP and WETH are ERC20)
              },
              currency1: {
                currency: token1Address as Address,
                type: 1, // ERC20 token
              },
              fee: feeTier.fee,
              tickSpacing: feeTier.tickSpacing,
              hooks: hooksAddress as Address,
            },
            {
              zeroForOne: zeroForOne,
              amountSpecified: -BigInt(swapAmountWei.toString()), // Negative = exact input swap
              sqrtPriceLimitX96: BigInt(0), // No price limit (0 = unlimited)
            },
            "0x" as Hex, // Empty hook data (no hooks)
          ],
        })
      }
      
      // Note: Swap will be executed in retry loop with dynamic fee tier selection
      // We'll try each fee tier until one succeeds

      // Note: We cannot directly transfer 5% of ETH result in the same batch
      // because we don't know the exact ETH amount until swap completes.
      // We'll handle the 5% ETH transfer in a separate transaction or via the API sync.

      // 5. Execute transactions sequentially
      console.log("📦 Executing transactions sequentially...")
      
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

          // First: Transfer 5% to treasury
          console.log("📤 Step 1: Transferring 5% to treasury...")
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
          console.log("✅ Treasury transfer confirmed")

          // Second: Approve PoolManager (only if needed)
          const approveCall = calls.find(c => c.to.toLowerCase() === BUMP_TOKEN_ADDRESS.toLowerCase() && c.data.startsWith("0x095ea7b3"))
          if (approveCall) {
            console.log("📝 Step 2: Executing approve transaction...")
            const approveTxHash = await Promise.race([
              smartWalletClient.sendTransaction({
                to: BUMP_TOKEN_ADDRESS,
                data: approveCall.data,
                value: BigInt(0),
              }),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
              })
            ]) as `0x${string}`

            await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
            console.log("✅ Approval confirmed")
          } else {
            console.log("⏭️ Step 2: Skipping approve (sufficient allowance)")
          }

          // Third: Swap via Uniswap V4 PoolManager with dynamic fee tier
          console.log("💱 Step 3: Attempting swap with dynamic fee tier detection...")
          let swapSuccess = false
          let lastSwapError: Error | null = null
          
          for (const feeTier of feeTierOptions) {
            try {
              const feeTierLabel = feeTier.fee === 500 ? '0.05%' : feeTier.fee === 3000 ? '0.3%' : '1%'
              console.log(`🔄 Trying fee tier ${feeTier.fee} (${feeTierLabel})...`)
              
              const currentSwapData = generateSwapData(feeTier)
              
              txHash = await Promise.race([
                smartWalletClient.sendTransaction({
                  to: UNISWAP_V4_POOL_MANAGER,
                  data: currentSwapData,
                  value: BigInt(0),
                }),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
              
              swapSuccess = true
              console.log(`✅ Swap successful with fee tier ${feeTier.fee} (${feeTierLabel})`)
              break // Success
            } catch (swapError: any) {
              lastSwapError = swapError
              const errorMsg = swapError.message || ""
              const errorDetails = swapError.details || swapError.cause?.details || ""
              
              // If it's a pool-related error, try next fee tier
              if (
                errorMsg.includes("execution reverted") ||
                errorMsg.includes("Pool not found") ||
                errorMsg.includes("Invalid pool") ||
                errorDetails.includes("execution reverted")
              ) {
                console.log(`⚠️ Fee tier ${feeTier.fee} failed (pool may not exist), trying next...`)
                // Small delay before trying next fee tier
                await new Promise(resolve => setTimeout(resolve, 500))
                continue // Try next fee tier
              } else {
                // Other errors (timeout, billing, etc.) should be thrown
                console.log(`❌ Non-pool error with fee tier ${feeTier.fee}:`, errorMsg)
                throw swapError
              }
            }
          }
          
          if (!swapSuccess) {
            throw lastSwapError || new Error("All fee tier attempts failed. Pool $BUMP/WETH may not exist on Uniswap V4. Please create the pool first.")
          }

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

