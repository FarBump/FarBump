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

// Uniswap V4 PoolManager ABI - Complete Flash Accounting Interface
// V4 uses Currency struct (address + type) instead of direct addresses
// Currency: { currency: address, type: uint8 } where type 0 = native ETH, 1 = ERC20
// Flash Accounting Flow: unlock() -> swap() -> settle() -> take()
const UNISWAP_V4_POOL_MANAGER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "currency", type: "address" },
          { name: "type", type: "uint8" }, // 0 = native ETH, 1 = ERC20
        ],
        name: "currency",
        type: "tuple",
      },
    ],
    name: "unlock",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              { name: "currency", type: "address" },
              { name: "type", type: "uint8" },
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
  {
    inputs: [
      {
        components: [
          { name: "currency", type: "address" },
          { name: "type", type: "uint8" },
        ],
        name: "currency",
        type: "tuple",
      },
      { name: "amount", type: "uint256" },
    ],
    name: "settle",
    outputs: [{ name: "amount0", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "currency", type: "address" },
          { name: "type", type: "uint8" },
        ],
        name: "currency",
        type: "tuple",
      },
      { name: "to", type: "address" },
      { name: "amount", type: "uint128" },
    ],
    name: "take",
    outputs: [{ name: "amount0", type: "uint128" }],
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
  const [isApproving, setIsApproving] = useState(false)
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | null>(null)

  const reset = () => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
    setIsApproving(false)
    setApprovalHash(null)
  }

  /**
   * Approve Uniswap V4 PoolManager to spend $BUMP tokens
   * This function checks allowance first and only approves if needed
   */
  const approve = async (amount: string) => {
    setIsApproving(true)
    setError(null)

    try {
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      if (!publicClient) {
        throw new Error("Public client not available")
      }

      const userAddress = smartWalletClient.account.address
      const amountWei = parseUnits(amount, BUMP_DECIMALS)

      // Check current allowance
      console.log("🔍 Checking current allowance...")
      const currentAllowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, UNISWAP_V4_POOL_MANAGER as Address],
      })

      console.log(`📊 Current Allowance: ${currentAllowance.toString()}, Required: ${amountWei.toString()}`)

      // If allowance is sufficient, no need to approve
      if (currentAllowance >= amountWei) {
        console.log("✅ Sufficient allowance already exists")
        setIsApproving(false)
        return { approved: true, hash: null as `0x${string}` | null }
      }

      // Approve needed
      console.log("📝 Approval needed, sending approve transaction...")
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [UNISWAP_V4_POOL_MANAGER as Address, amountWei],
      })

      const MAX_RETRIES = 2
      const TIMEOUT_MS = 30000
      let approveTxHash: `0x${string}` | null = null

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.pow(2, attempt - 1) * 1000
            console.log(`⏳ Waiting ${delay}ms before retry...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }

          approveTxHash = await Promise.race([
            smartWalletClient.sendTransaction({
              to: BUMP_TOKEN_ADDRESS,
              data: approveData,
              value: BigInt(0),
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
            })
          ]) as `0x${string}`

          // Wait for confirmation
          await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
          console.log("✅ Approval confirmed")
          setApprovalHash(approveTxHash)
          break
        } catch (attemptError: any) {
          if (attempt === MAX_RETRIES) {
            throw attemptError
          }
          const errorMessage = attemptError.message || ""
          if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
            console.log(`⚠️ Timeout detected, will retry (${attempt + 1}/${MAX_RETRIES})...`)
            continue
          } else {
            throw attemptError
          }
        }
      }

      setIsApproving(false)
      return { approved: true, hash: approveTxHash }
    } catch (err: any) {
      setIsApproving(false)
      console.error("❌ Approval Error:", err)
      
      let friendlyMessage = err.message || "Approval failed"
      if (friendlyMessage.includes("timeout") || friendlyMessage.includes("timed out")) {
        friendlyMessage = "Approval request timed out. Please try again."
      } else if (friendlyMessage.includes("insufficient funds")) {
        friendlyMessage = "Insufficient $BUMP balance for approval."
      }

      setError(new Error(friendlyMessage))
      throw new Error(friendlyMessage)
    }
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

      // 4. Verify allowance before swap
      console.log("🔍 Verifying allowance before swap...")
      const currentAllowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, UNISWAP_V4_POOL_MANAGER as Address],
      })
      
      console.log(`📊 Current Allowance: ${currentAllowance.toString()}, Required: ${swapAmountWei.toString()}`)
      
      if (currentAllowance < swapAmountWei) {
        throw new Error("Insufficient allowance. Please approve first by clicking the 'Approve' button.")
      }
      
      console.log("✅ Sufficient allowance confirmed")

      // 5. Prepare Uniswap V4 Flash Accounting Flow
      // Flow: unlock() -> swap() -> settle() -> take()
      // Determine token order (currency0 must be < currency1 by address)
      const token0Address = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
        ? BUMP_TOKEN_ADDRESS
        : BASE_WETH_ADDRESS
      const token1Address = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
        ? BASE_WETH_ADDRESS
        : BUMP_TOKEN_ADDRESS
      const zeroForOne = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
      
      // Pool configuration - Try multiple fee tiers dynamically
      const feeTierOptions = [
        { fee: 500, tickSpacing: 1 },   // 0.05%
        { fee: 3000, tickSpacing: 60 }, // 0.3%
        { fee: 10000, tickSpacing: 200 }, // 1%
      ]
      
      const hooksAddress = "0x0000000000000000000000000000000000000000" as Address // No hooks
      
      // Currency structs for V4
      const bumpCurrency = {
        currency: BUMP_TOKEN_ADDRESS as Address,
        type: 1 as const, // ERC20
      }
      const wethCurrency = {
        currency: BASE_WETH_ADDRESS as Address,
        type: 1 as const, // ERC20
      }
      const currency0 = {
        currency: token0Address as Address,
        type: 1 as const,
      }
      const currency1 = {
        currency: token1Address as Address,
        type: 1 as const,
      }

      // 6. Execute batch transaction with Flash Accounting
      console.log("📦 Executing Uniswap V4 Flash Accounting flow...")
      
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

          // Try each fee tier until one succeeds
          let swapSuccess = false
          let lastSwapError: Error | null = null
          
          for (const feeTier of feeTierOptions) {
            try {
              const feeTierLabel = feeTier.fee === 500 ? '0.05%' : feeTier.fee === 3000 ? '0.3%' : '1%'
              console.log(`🔄 Attempting swap with fee tier ${feeTier.fee} (${feeTierLabel})...`)
              
              // Prepare batch calls for Flash Accounting
              const batchCalls: Array<{
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
              batchCalls.push({
                to: BUMP_TOKEN_ADDRESS as Address,
                data: transferData,
                value: BigInt(0),
              })

              // Call 2: Unlock $BUMP currency for PoolManager
              const unlockBumpData = encodeFunctionData({
                abi: UNISWAP_V4_POOL_MANAGER_ABI,
                functionName: "unlock",
                args: [bumpCurrency],
              })
              batchCalls.push({
                to: UNISWAP_V4_POOL_MANAGER,
                data: unlockBumpData,
                value: BigInt(0),
              })

              // Call 3: Unlock WETH currency for PoolManager
              const unlockWethData = encodeFunctionData({
                abi: UNISWAP_V4_POOL_MANAGER_ABI,
                functionName: "unlock",
                args: [wethCurrency],
              })
              batchCalls.push({
                to: UNISWAP_V4_POOL_MANAGER,
                data: unlockWethData,
                value: BigInt(0),
              })

              // Call 4: Swap $BUMP to WETH
              // Note: Uniswap V4 swap() handles flash accounting internally
              // It will automatically settle the input ($BUMP) and take the output (WETH)
              // We just need to ensure currencies are unlocked first
              const swapData = encodeFunctionData({
                abi: UNISWAP_V4_POOL_MANAGER_ABI,
                functionName: "swap",
                args: [
                  {
                    currency0,
                    currency1,
                    fee: feeTier.fee,
                    tickSpacing: feeTier.tickSpacing,
                    hooks: hooksAddress,
                  },
                  {
                    zeroForOne: zeroForOne,
                    amountSpecified: -BigInt(swapAmountWei.toString()), // Negative = exact input
                    sqrtPriceLimitX96: BigInt(0), // No price limit
                  },
                  "0x" as Hex, // Empty hook data
                ],
              })
              batchCalls.push({
                to: UNISWAP_V4_POOL_MANAGER,
                data: swapData,
                value: BigInt(0),
              })
              
              // Note: settle() and take() are handled internally by swap() in V4
              // The swap function uses flash accounting to:
              // 1. Take input tokens ($BUMP) from user via settle()
              // 2. Give output tokens (WETH) to user via take()
              // All within the same transaction

              // Execute batch transaction
              // Note: Privy smart wallet supports batch transactions via sendTransactions
              // If not available, we'll send sequentially but they should be in the same UserOperation
              console.log(`📤 Executing ${batchCalls.length} calls in batch...`)
              
              // Try to send as batch if sendTransactions exists
              if (typeof (smartWalletClient as any).sendTransactions === 'function') {
                console.log("✅ Using sendTransactions for batch execution...")
                txHash = await Promise.race([
                  (smartWalletClient as any).sendTransactions({
                    transactions: batchCalls,
                  }),
                  new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                  })
                ]) as `0x${string}`
              } else {
                // Fallback: Send sequentially (they should still be in the same UserOperation)
                console.log("⚠️ sendTransactions not available, using sequential approach...")
                
                // Send transfer first
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

                // Wait for transfer confirmation
                await publicClient.waitForTransactionReceipt({ hash: transferTxHash })
                console.log("✅ Treasury transfer confirmed")

                // Send unlock calls (can be done in parallel or sequentially)
                console.log("🔓 Unlocking currencies...")
                for (const unlockCall of [unlockBumpData, unlockWethData]) {
                  const unlockTxHash = await smartWalletClient.sendTransaction({
                    to: UNISWAP_V4_POOL_MANAGER,
                    data: unlockCall,
                    value: BigInt(0),
                  })
                  await publicClient.waitForTransactionReceipt({ hash: unlockTxHash })
                }
                console.log("✅ Currencies unlocked")
                
                // Then send swap (which internally handles settle/take via flash accounting)
                console.log("💱 Executing swap...")
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
              }
              
              // Note: The 5% WETH fee to treasury will be handled in the backend API
              // after we know the exact WETH amount received from the swap
              
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
                errorMsg.includes("Locked") ||
                errorDetails.includes("execution reverted")
              ) {
                console.log(`⚠️ Fee tier ${feeTier.fee} failed (pool may not exist or locked), trying next...`)
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
    approve,
    hash,
    approvalHash,
    isPending,
    isApproving,
    isSuccess,
    error,
    reset,
  }
}

