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
  BUMP_POOL_HOOK_ADDRESS,
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

      // 5. Prepare Uniswap V4 Flash Accounting Flow with Dynamic Fee
      // Flow: unlock() -> swap() -> settle() -> take()
      // 
      // CRITICAL: Token order must be correct (currency0 < currency1 by address)
      // This is required for PoolKey construction
      const bumpAddressLower = BUMP_TOKEN_ADDRESS.toLowerCase()
      const wethAddressLower = BASE_WETH_ADDRESS.toLowerCase()
      
      const isBumpToken0 = bumpAddressLower < wethAddressLower
      const token0Address = isBumpToken0 ? BUMP_TOKEN_ADDRESS : BASE_WETH_ADDRESS
      const token1Address = isBumpToken0 ? BASE_WETH_ADDRESS : BUMP_TOKEN_ADDRESS
      const zeroForOne = isBumpToken0 // If BUMP is token0, we're swapping token0 -> token1
      
      // Dynamic Fee Configuration for $BUMP/WETH pool
      // Dynamic Fee uses fee = 8388608 (0x800000) as the flag
      const DYNAMIC_FEE = 8388608 // 0x800000 - Dynamic Fee flag
      const DYNAMIC_FEE_TICK_SPACING = 1 // Standard tick spacing for Dynamic Fee
      
      // Hook Address for $BUMP/WETH pool (from user specification)
      const hooksAddress = BUMP_POOL_HOOK_ADDRESS
      
      // Currency structs for V4
      // Currency: { currency: address, type: uint8 } where type 0 = native ETH, 1 = ERC20
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
        type: 1 as const, // ERC20
      }
      const currency1 = {
        currency: token1Address as Address,
        type: 1 as const, // ERC20
      }
      
      // PoolKey for $BUMP/WETH Dynamic Fee pool
      // CRITICAL: Must match the actual pool configuration on-chain
      const poolKey = {
        currency0,
        currency1,
        fee: DYNAMIC_FEE, // 8388608 (0x800000) - Dynamic Fee flag
        tickSpacing: DYNAMIC_FEE_TICK_SPACING, // 1 for Dynamic Fee
        hooks: hooksAddress, // 0xd60D6B218116cFd801E28F78d011a203D2b068Cc
      }
      
      console.log("🔑 PoolKey Configuration:")
      console.log(`  - Currency0: ${token0Address} (${isBumpToken0 ? '$BUMP' : 'WETH'})`)
      console.log(`  - Currency1: ${token1Address} (${isBumpToken0 ? 'WETH' : '$BUMP'})`)
      console.log(`  - Fee: ${DYNAMIC_FEE} (Dynamic Fee)`)
      console.log(`  - Tick Spacing: ${DYNAMIC_FEE_TICK_SPACING}`)
      console.log(`  - Hooks: ${hooksAddress}`)
      console.log(`  - ZeroForOne: ${zeroForOne} (swapping ${isBumpToken0 ? '$BUMP -> WETH' : 'WETH -> $BUMP'})`)

      // 6. Prepare batch calls for Flash Accounting (all in one transaction)
      console.log("📦 Preparing Uniswap V4 Flash Accounting batch with Dynamic Fee...")
      
      // Prepare all calls for batch transaction
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

      // Call 4: Swap $BUMP to WETH (Exact Input Swap)
      // CRITICAL: This swap will create balance deltas that must be settled/taken
      // Hook data can be empty (0x) if hooks don't require specific data
      // If hooks require data, it should be encoded according to hook interface
      const hookData = "0x" as Hex // Empty hook data - update if hooks require specific data
      
      const swapData = encodeFunctionData({
        abi: UNISWAP_V4_POOL_MANAGER_ABI,
        functionName: "swap",
        args: [
          poolKey, // PoolKey with correct currency order, Dynamic Fee, and Hook address
          {
            zeroForOne: zeroForOne,
            amountSpecified: -BigInt(swapAmountWei.toString()), // Negative = exact input swap
            sqrtPriceLimitX96: BigInt(0), // No price limit (0 = unlimited)
          },
          hookData, // Hook data (empty for now, update if hooks require data)
        ],
      })
      batchCalls.push({
        to: UNISWAP_V4_POOL_MANAGER,
        data: swapData,
        value: BigInt(0),
      })

      // Call 5: Settle $BUMP debt (send $BUMP to PoolManager)
      // CRITICAL: This settles the negative delta from the swap
      // After swap, PoolManager expects $BUMP tokens to be sent to it
      // The amount is the exact input amount (swapAmountWei)
      // This must be called AFTER swap to resolve the negative balance delta
      const settleData = encodeFunctionData({
        abi: UNISWAP_V4_POOL_MANAGER_ABI,
        functionName: "settle",
        args: [bumpCurrency, swapAmountWei], // Currency and amount to settle
      })
      batchCalls.push({
        to: UNISWAP_V4_POOL_MANAGER,
        data: settleData,
        value: BigInt(0),
      })

      // Call 6: Take WETH output (receive WETH from PoolManager)
      // CRITICAL: This takes the positive delta from the swap
      // After swap, PoolManager holds WETH tokens that belong to the user
      // Use max uint128 to take all available WETH from the swap
      // The actual amount taken will be the amount received from swap (less than max)
      // This must be called AFTER swap to claim the positive balance delta
      const maxWethAmount = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF") // Max uint128
      const takeData = encodeFunctionData({
        abi: UNISWAP_V4_POOL_MANAGER_ABI,
        functionName: "take",
        args: [
          wethCurrency, // Currency to take (WETH)
          userAddress as Address, // Recipient address
          maxWethAmount, // Maximum amount to take (will take actual amount available)
        ],
      })
      batchCalls.push({
        to: UNISWAP_V4_POOL_MANAGER,
        data: takeData,
        value: BigInt(0),
      })

      // 7. Execute batch transaction (all calls in one UserOperation)
      console.log(`📤 Executing ${batchCalls.length} calls in single batch transaction...`)
      console.log("  1. Transfer 5% $BUMP to Treasury")
      console.log("  2. Unlock $BUMP currency")
      console.log("  3. Unlock WETH currency")
      console.log("  4. Swap $BUMP to WETH (Dynamic Fee)")
      console.log("  5. Settle $BUMP debt")
      console.log("  6. Take WETH output")
      
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

          // CRITICAL: All calls must be in one batch transaction for Flash Accounting atomicity
          // Try multiple methods to send batch transactions
          let batchMethodFound = false
          
          // Method 1: Try sendTransactions (if available)
          if (typeof (smartWalletClient as any).sendTransactions === 'function') {
            console.log("✅ Using sendTransactions for atomic batch execution...")
            txHash = await Promise.race([
              (smartWalletClient as any).sendTransactions({
                transactions: batchCalls,
              }),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
              })
            ]) as `0x${string}`
            batchMethodFound = true
          }
          // Method 2: Try executeBatch (ERC-4337 standard)
          else if (typeof (smartWalletClient as any).executeBatch === 'function') {
            console.log("✅ Using executeBatch for atomic batch execution...")
            txHash = await Promise.race([
              (smartWalletClient as any).executeBatch(batchCalls),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
              })
            ]) as `0x${string}`
            batchMethodFound = true
          }
          // Method 3: Try using account's executeBatch directly
          else if (smartWalletClient.account && typeof (smartWalletClient.account as any).executeBatch === 'function') {
            console.log("✅ Using account.executeBatch for atomic batch execution...")
            txHash = await Promise.race([
              (smartWalletClient.account as any).executeBatch(batchCalls),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
              })
            ]) as `0x${string}`
            batchMethodFound = true
          }
          
          if (!batchMethodFound) {
            // If no batch method is available, we cannot proceed
            // Sequential execution breaks Flash Accounting atomicity and will cause revert
            throw new Error(
              "Batch transaction method not available. " +
              "Flash Accounting requires all calls (unlock, swap, settle, take) to be in a single atomic transaction. " +
              "Please ensure your smart wallet supports batch transactions (sendTransactions, executeBatch, etc.)."
            )
          }
          
          // Note: The 5% WETH fee to treasury will be handled in the backend API
          // after we know the exact WETH amount received from the swap

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

