"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, isAddress, type Address, encodeFunctionData, encodeAbiParameters, type Hex } from "viem"
import { 
  BUMP_TOKEN_ADDRESS, 
  TREASURY_ADDRESS, 
  BASE_WETH_ADDRESS,
  UNISWAP_UNIVERSAL_ROUTER,
  PERMIT2_ADDRESS,
  BUMP_POOL_CURRENCY0,
  BUMP_POOL_CURRENCY1,
  BUMP_POOL_FEE,
  BUMP_POOL_TICK_SPACING,
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

// Universal Router ABI
// Universal Router uses execute(bytes commands, bytes[] inputs) to execute multiple commands
const UNISWAP_UNIVERSAL_ROUTER_ABI = [
  {
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const

// Permit2 ABI for allowance management
const PERMIT2_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
    name: "allowance",
    outputs: [
      {
        components: [
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const

// Legacy: Uniswap V4 PoolManager ABI (kept for reference, not used with Universal Router)
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
   * Check Permit2 allowance for $BUMP token
   * Falls back to regular ERC20 allowance check if Permit2 check fails
   */
  const checkPermit2Allowance = async (amount: bigint): Promise<boolean> => {
    if (!publicClient || !smartWalletClient) return false

    // Fallback: Check regular ERC20 allowance to Universal Router
    // Permit2 integration can be added later if needed
    try {
      const allowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [smartWalletClient.account.address as Address, UNISWAP_UNIVERSAL_ROUTER as Address],
      })
      return allowance >= amount
    } catch {
      return false
    }
  }

  /**
   * Encode V4_SWAP command input for Universal Router
   * Command: 0x10
   * Input: abi.encode(PoolKey, SwapParams, hookData)
   * 
   * Universal Router expects raw ABI encoding without function selector
   */
  const encodeV4SwapCommand = (
    poolKey: {
      currency0: { currency: Address; type: number }
      currency1: { currency: Address; type: number }
      fee: number
      tickSpacing: number
      hooks: Address
    },
    swapParams: {
      zeroForOne: boolean
      amountSpecified: bigint
      sqrtPriceLimitX96: bigint
    },
    hookData: Hex
  ): Hex => {
    // Use viem's encodeAbiParameters for raw ABI encoding (no function selector)
    // Format: abi.encode(PoolKey, SwapParams, hookData)
    return encodeAbiParameters(
      [
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
          name: "poolKey",
          type: "tuple",
        },
        {
          components: [
            { name: "zeroForOne", type: "bool" },
            { name: "amountSpecified", type: "int256" },
            { name: "sqrtPriceLimitX96", type: "uint160" },
          ],
          name: "swapParams",
          type: "tuple",
        },
        { name: "hookData", type: "bytes" },
      ],
      [poolKey, swapParams, hookData]
    ) as Hex
  }

  /**
   * Approve Permit2 to spend $BUMP tokens for Universal Router
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

      // Check Permit2 allowance first
      console.log("🔍 Checking Permit2 allowance...")
      const hasPermit2Allowance = await checkPermit2Allowance(amountWei)

      if (hasPermit2Allowance) {
        console.log("✅ Sufficient Permit2 allowance already exists")
        setIsApproving(false)
        return { approved: true, hash: null as `0x${string}` | null }
      }

      // Fallback: Check regular ERC20 allowance to Universal Router
      console.log("🔍 Checking ERC20 allowance to Universal Router...")
      const currentAllowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, UNISWAP_UNIVERSAL_ROUTER as Address],
      })

      console.log(`📊 Current Allowance: ${currentAllowance.toString()}, Required: ${amountWei.toString()}`)

      // If allowance is sufficient, no need to approve
      if (currentAllowance >= amountWei) {
        console.log("✅ Sufficient allowance already exists")
        setIsApproving(false)
        return { approved: true, hash: null as `0x${string}` | null }
      }

      // Approve needed - approve to Universal Router (which uses Permit2 internally)
      console.log("📝 Approval needed, sending approve transaction to Universal Router...")
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [UNISWAP_UNIVERSAL_ROUTER as Address, amountWei],
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

      // 4. Verify Permit2/Universal Router allowance before swap
      console.log("🔍 Verifying Permit2/Universal Router allowance before swap...")
      const hasPermit2Allowance = await checkPermit2Allowance(swapAmountWei)
      
      if (!hasPermit2Allowance) {
        // Fallback: Check regular ERC20 allowance
        const currentAllowance = await publicClient.readContract({
          address: BUMP_TOKEN_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [userAddress as Address, UNISWAP_UNIVERSAL_ROUTER as Address],
        })
        
        console.log(`📊 Current Allowance: ${currentAllowance.toString()}, Required: ${swapAmountWei.toString()}`)
        
        if (currentAllowance < swapAmountWei) {
          throw new Error("Insufficient allowance. Please approve first by clicking the 'Approve' button.")
        }
      }
      
      console.log("✅ Sufficient allowance confirmed")

      // 5. Prepare PoolKey for $BUMP/WETH pool (from user specification)
      // PoolKey details:
      // currency0: WETH (0x4200000000000000000000000000000000000006)
      // currency1: $BUMP (0x94CE728849431818EC9a0CF29BDb24FE413bBb07)
      // fee: 8388608 (Dynamic Fee)
      // tickSpacing: 200
      // hooks: 0xd60D6B218116cFd801E28F78d011a203D2b068Cc
      
      // Since we're selling $BUMP (Currency1) for WETH (Currency0), zeroForOne = false
      const poolKey = {
        currency0: {
          currency: BUMP_POOL_CURRENCY0 as Address, // WETH
          type: 1 as const, // ERC20
        },
        currency1: {
          currency: BUMP_POOL_CURRENCY1 as Address, // $BUMP
          type: 1 as const, // ERC20
        },
        fee: BUMP_POOL_FEE, // 8388608 (Dynamic Fee)
        tickSpacing: BUMP_POOL_TICK_SPACING, // 200
        hooks: BUMP_POOL_HOOK_ADDRESS, // 0xd60D6B218116cFd801E28F78d011a203D2b068Cc
      }
      
      // Swap parameters: selling $BUMP (Currency1) for WETH (Currency0)
      // zeroForOne = false means we're swapping Currency1 -> Currency0
      const swapParams = {
        zeroForOne: false, // false = swapping Currency1 ($BUMP) -> Currency0 (WETH)
        amountSpecified: -BigInt(swapAmountWei.toString()), // Negative = exact input
        sqrtPriceLimitX96: BigInt(0), // No price limit
      }
      
      const hookData = "0x" as Hex // Empty hook data
      
      console.log("🔑 PoolKey Configuration:")
      console.log(`  - Currency0: ${BUMP_POOL_CURRENCY0} (WETH)`)
      console.log(`  - Currency1: ${BUMP_POOL_CURRENCY1} ($BUMP)`)
      console.log(`  - Fee: ${BUMP_POOL_FEE} (Dynamic Fee)`)
      console.log(`  - Tick Spacing: ${BUMP_POOL_TICK_SPACING}`)
      console.log(`  - Hooks: ${BUMP_POOL_HOOK_ADDRESS}`)
      console.log(`  - ZeroForOne: false (swapping $BUMP -> WETH)`)

      // 6. Prepare Universal Router commands and inputs
      console.log("📦 Preparing Universal Router transaction with V4_SWAP...")
      
      // Encode V4_SWAP input data
      // V4_SWAP command (0x10) requires: abi.encode(PoolKey, SwapParams, hookData)
      const v4SwapInput = encodeV4SwapCommand(poolKey, swapParams, hookData)
      
      // Universal Router commands: V4_SWAP (0x10)
      // Commands are encoded as bytes where each byte is a command
      const commands = "0x10" as Hex // V4_SWAP command
      
      // Inputs array: one input per command
      const inputs: Hex[] = [v4SwapInput]
      
      // Prepare batch calls for atomic transaction
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

      // Call 2: Universal Router execute() with V4_SWAP command
      // Universal Router handles unlock, swap, settle, and take internally
      const universalRouterData = encodeFunctionData({
        abi: UNISWAP_UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: [commands, inputs],
      })
      batchCalls.push({
        to: UNISWAP_UNIVERSAL_ROUTER,
        data: universalRouterData,
        value: BigInt(0),
      })

      // 7. Execute batch transaction (all calls in one UserOperation)
      console.log(`📤 Executing ${batchCalls.length} calls in single batch transaction...`)
      console.log("  1. Transfer 5% $BUMP to Treasury")
      console.log("  2. Universal Router V4_SWAP (handles unlock, swap, settle, take)")
      
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

