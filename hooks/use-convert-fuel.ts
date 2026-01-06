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
  BUMP_DECIMALS,
  TREASURY_FEE_BPS,
  WETH_DECIMALS,
} from "@/lib/constants"

// Import 0x API hook
const ZEROX_API_BASE_URL = "https://base.api.0x.org"
const ZEROX_API_KEY = process.env.NEXT_PUBLIC_ZEROX_API_KEY || ""

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

// Permit2 ABI for allowance management and approval
const PERMIT2_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const

// WETH ABI for unwrapping
const WETH_ABI = [
  {
    inputs: [{ name: "wad", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const

// 0x API v2 Response Structure
interface ZeroXQuoteResponse {
  chainId: number
  price: string
  estimatedPriceImpact: string
  buyAmount: string
  sellAmount: string
  buyToken: string
  sellToken: string
  allowanceTarget: string
  transaction: {
    to: string
    data: string
    value: string
    gas?: string
    gasPrice?: string
  }
  permit2?: {
    token: string
    spender: string
    amount: string
    expiration: string
    nonce: string
    sig: {
      r: string
      s: string
      v: number
    }
  }
  issues?: Array<{
    type: string
    reason: string
    severity: "error" | "warning" | "info"
  }>
}

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
   * Check if user has approved $BUMP to Permit2 contract
   * This is required before Permit2 can authorize Universal Router
   */
  const checkErc20ToPermit2Allowance = async (amount: bigint): Promise<boolean> => {
    if (!publicClient || !smartWalletClient) return false

    try {
      const allowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [smartWalletClient.account.address as Address, PERMIT2_ADDRESS as Address],
      })
      console.log(`📊 ERC20 Allowance to Permit2: ${allowance.toString()}`)
      return allowance >= amount
    } catch (err) {
      console.error("Error checking ERC20 allowance to Permit2:", err)
      return false
    }
  }

  /**
   * Check Permit2 allowance for Universal Router
   * This checks if Permit2 has authorized Universal Router to spend $BUMP
   */
  const checkPermit2Allowance = async (amount: bigint): Promise<{ hasAllowance: boolean; needsErc20Approval: boolean }> => {
    if (!publicClient || !smartWalletClient) {
      return { hasAllowance: false, needsErc20Approval: true }
    }

    // First check ERC20 allowance to Permit2
    const hasErc20Allowance = await checkErc20ToPermit2Allowance(amount)
    if (!hasErc20Allowance) {
      console.log("⚠️ Need ERC20 approval to Permit2 first")
      return { hasAllowance: false, needsErc20Approval: true }
    }

    // Then check Permit2 allowance for Universal Router
    try {
      const result = await publicClient.readContract({
        address: PERMIT2_ADDRESS as Address,
        abi: PERMIT2_ABI,
        functionName: "allowance",
        args: [
          smartWalletClient.account.address as Address, // owner
          BUMP_TOKEN_ADDRESS as Address,                 // token
          UNISWAP_UNIVERSAL_ROUTER as Address,          // spender
        ],
      })
      
      // Result is [amount, expiration, nonce] - all as bigint from viem
      const [allowedAmount, expiration] = result as unknown as [bigint, bigint, bigint]
      const currentTime = BigInt(Math.floor(Date.now() / 1000))
      
      console.log(`📊 Permit2 Allowance for Universal Router:`)
      console.log(`  - Amount: ${allowedAmount.toString()}`)
      console.log(`  - Expiration: ${expiration.toString()}`)
      console.log(`  - Current Time: ${currentTime.toString()}`)
      
      const hasEnough = allowedAmount >= amount && expiration > currentTime
      return { hasAllowance: hasEnough, needsErc20Approval: false }
    } catch (err) {
      console.error("Error checking Permit2 allowance:", err)
      // Permit2 check failed, but ERC20 allowance is ok
      return { hasAllowance: false, needsErc20Approval: false }
    }
  }

  /**
   * Get quote from 0x Swap API v2
   * Uses /swap/v2/quote endpoint for v2 API with Permit2 support
   */
  const get0xQuote = async (
    sellToken: Address,
    buyToken: Address,
    sellAmountWei: bigint,
    takerAddress: Address,
    slippagePercentage: number = 0.5
  ): Promise<ZeroXQuoteResponse> => {
    if (!ZEROX_API_KEY) {
      throw new Error("0x API key not configured. Please set NEXT_PUBLIC_ZEROX_API_KEY in .env.local")
    }

    const queryParams = new URLSearchParams({
      sellToken,
      buyToken,
      sellAmount: sellAmountWei.toString(),
      takerAddress,
      slippagePercentage: slippagePercentage.toString(),
      enablePermit2: "true", // Enable Permit2 for efficient approvals
    })

    const url = `${ZEROX_API_BASE_URL}/swap/v2/quote?${queryParams.toString()}`
    
    console.log("📊 Fetching 0x Swap API v2 quote...")
    console.log(`  URL: ${url}`)
    console.log(`  Sell Token: ${sellToken}`)
    console.log(`  Buy Token: ${buyToken}`)
    console.log(`  Sell Amount: ${sellAmountWei.toString()} wei`)
    console.log(`  API Version: v2`)

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "0x-api-key": ZEROX_API_KEY,
        "Accept": "application/json",
      },
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: "Unknown error" }))
      
      // v2 API provides better error messages with issues array
      if (errorData.issues && Array.isArray(errorData.issues)) {
        const errorMessages = errorData.issues
          .filter((issue: any) => issue.severity === "error")
          .map((issue: any) => issue.reason)
          .join(", ")
        throw new Error(`0x API v2 error: ${errorMessages || errorData.reason || errorData.message || response.statusText}`)
      }
      
      throw new Error(`0x API v2 error: ${errorData.reason || errorData.message || response.statusText}`)
    }

    const quoteData: ZeroXQuoteResponse = await response.json()
    
    // Check for issues in v2 response
    if (quoteData.issues && quoteData.issues.length > 0) {
      const errors = quoteData.issues.filter(issue => issue.severity === "error")
      if (errors.length > 0) {
        const errorMessages = errors.map(issue => issue.reason).join(", ")
        throw new Error(`0x API v2 issues detected: ${errorMessages}`)
      }
      
      // Log warnings if any
      const warnings = quoteData.issues.filter(issue => issue.severity === "warning")
      if (warnings.length > 0) {
        console.warn("⚠️ 0x API v2 warnings:", warnings.map(w => w.reason).join(", "))
      }
    }
    
    console.log("✅ 0x API v2 Quote received:")
    console.log(`  - Price: ${quoteData.price}`)
    console.log(`  - Buy Amount: ${quoteData.buyAmount}`)
    console.log(`  - Sell Amount: ${quoteData.sellAmount}`)
    console.log(`  - Estimated Price Impact: ${quoteData.estimatedPriceImpact}%`)
    console.log(`  - Transaction To: ${quoteData.transaction.to}`)
    console.log(`  - Has Permit2: ${!!quoteData.permit2}`)

    return quoteData
  }

  /**
   * Encode PAY_PORTION command input for Universal Router
   * Command: 0x06
   * Input: abi.encode(token, recipient, bips)
   */
  const encodePayPortionCommand = (
    token: Address,
    recipient: Address,
    bips: number
  ): Hex => {
    return encodeAbiParameters(
      [
        { name: "token", type: "address" },
        { name: "recipient", type: "address" },
        { name: "bips", type: "uint256" },
      ],
      [token, recipient, BigInt(bips)]
    ) as Hex
  }

  /**
   * Encode SWEEP command input for Universal Router
   * Command: 0x04
   * Input: abi.encode(token, recipient, amountMin)
   * For native ETH, use address(0) as token
   */
  const encodeSweepCommand = (
    token: Address,
    recipient: Address,
    amountMin: bigint
  ): Hex => {
    return encodeAbiParameters(
      [
        { name: "token", type: "address" },
        { name: "recipient", type: "address" },
        { name: "amountMin", type: "uint256" },
      ],
      [token, recipient, amountMin]
    ) as Hex
  }

  /**
   * Approve $BUMP tokens to Permit2 contract
   * This is the first step - user must approve ERC20 to Permit2
   * Then Permit2.approve() will be called in convert() to authorize Universal Router
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

      // Check ERC20 allowance to Permit2
      console.log("🔍 Checking ERC20 allowance to Permit2...")
      const currentAllowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, PERMIT2_ADDRESS as Address],
      })

      console.log(`📊 Current Allowance to Permit2: ${currentAllowance.toString()}, Required: ${amountWei.toString()}`)

      // If allowance is sufficient, no need to approve
      if (currentAllowance >= amountWei) {
        console.log("✅ Sufficient ERC20 allowance to Permit2 already exists")
        setIsApproving(false)
        return { approved: true, hash: null as `0x${string}` | null }
      }

      // Approve ERC20 to Permit2 with max amount (so user doesn't need to approve again)
      console.log("📝 ERC20 approval needed, sending approve transaction to Permit2...")
      console.log(`  - Token: ${BUMP_TOKEN_ADDRESS}`)
      console.log(`  - Spender: ${PERMIT2_ADDRESS} (Permit2)`)
      console.log(`  - Amount: MAX_UINT256 (unlimited)`)
      
      // Use max uint256 for ERC20 approval to Permit2 (common practice)
      const maxUint256 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS as Address, maxUint256],
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

      // 4. Verify ERC20 approval to Permit2 before swap
      // User must have approved $BUMP to Permit2 first
      console.log("🔍 Verifying ERC20 allowance to Permit2...")
      const erc20ToPermit2Allowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, PERMIT2_ADDRESS as Address],
      })
      
      console.log(`📊 ERC20 Allowance to Permit2: ${erc20ToPermit2Allowance.toString()}, Required: ${totalAmountWei.toString()}`)
      
      if (erc20ToPermit2Allowance < totalAmountWei) {
        throw new Error("Insufficient ERC20 allowance to Permit2. Please approve first by clicking the 'Approve' button.")
      }
      
      console.log("✅ ERC20 allowance to Permit2 confirmed")

      // 5. Get 0x API v2 quote for swap
      console.log("📊 Getting 0x API v2 quote for swap...")
      const zeroXQuote = await get0xQuote(
        BUMP_TOKEN_ADDRESS as Address,
        BASE_WETH_ADDRESS as Address,
        swapAmountWei,
        userAddress as Address,
        0.5 // 0.5% slippage
      )

      console.log("✅ 0x API v2 quote received:")
      console.log(`  - Buy Amount (WETH): ${zeroXQuote.buyAmount}`)
      console.log(`  - Price: ${zeroXQuote.price}`)
      console.log(`  - Estimated Price Impact: ${zeroXQuote.estimatedPriceImpact}%`)

      // 6. Prepare transactions:
      // Step 1: Transfer 5% $BUMP to Treasury
      // Step 2: Execute 0x swap (95% $BUMP to WETH) - result goes to smart wallet
      // Step 3: Unwrap WETH to ETH
      // Step 4: Distribute ETH (5% to Treasury, 90% stays in wallet as credit)

      // Step 1: Transfer 5% $BUMP to Treasury
      const transferTreasuryData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [TREASURY_ADDRESS as Address, treasuryFeeWei],
      })

      // Step 2: Execute 0x swap transaction (swap 95% $BUMP to WETH)
      // 0x API returns transaction data that we execute directly
      const zeroXSwapTx = {
        to: zeroXQuote.transaction.to as Address,
        data: zeroXQuote.transaction.data as Hex,
        value: BigInt(zeroXQuote.transaction.value || "0"),
      }

      // Step 3: Unwrap WETH to ETH (after swap, we'll have WETH in wallet)
      // We'll unwrap the amount we expect from the swap (from quote)
      // Note: If there's other WETH in wallet, this will only unwrap the swap amount
      // For batch execution, we use the buyAmount from quote
      const unwrapWethData = encodeFunctionData({
        abi: WETH_ABI,
        functionName: "withdraw",
        args: [BigInt(zeroXQuote.buyAmount)], // Unwrap WETH received from swap
      })

      // Step 4: Calculate ETH distribution
      // After unwrap, we have ETH in wallet
      // 5% of total initial = 5% / 95% = ~5.263% of swap result
      const payPortionBips = Math.floor((TREASURY_FEE_BPS * 10000) / (10000 - TREASURY_FEE_BPS)) // ~526 bips
      
      // Use Universal Router for ETH distribution (PAY_PORTION + SWEEP)
      const payPortionInput = encodePayPortionCommand(
        "0x0000000000000000000000000000000000000000" as Address, // Native ETH
        TREASURY_ADDRESS as Address,
        payPortionBips
      )

      const sweepInput = encodeSweepCommand(
        "0x0000000000000000000000000000000000000000" as Address, // Native ETH
        userAddress as Address,
        BigInt(0) // Sweep all remaining
      )

      // Universal Router commands for ETH distribution: PAY_PORTION (0x06) + SWEEP (0x04)
      const distributionCommands = "0x0604" as Hex
      const distributionInputs: Hex[] = [payPortionInput, sweepInput]

      const distributionData = encodeFunctionData({
        abi: UNISWAP_UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: [distributionCommands, distributionInputs],
      })

      // 7. Execute all transactions in batch
      console.log("📤 Executing transactions using 0x API v2...")
      console.log("  Step 1: Transfer 5% $BUMP to Treasury")
      console.log("  Step 2: 0x API swap (95% $BUMP to WETH)")
      console.log("  Step 3: Unwrap WETH to ETH")
      console.log("  Step 4: Distribute ETH (5% to Treasury, 90% to user)")

      const MAX_RETRIES = 2
      const TIMEOUT_MS = 60000 // 60 seconds for 0x API
      
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

          // Batch all operations:
          // 1. Transfer 5% $BUMP to Treasury
          // 2. 0x swap (95% $BUMP to WETH)
          // 3. Unwrap WETH to ETH
          // 4. Distribute ETH (5% Treasury, 90% user)
          const batchCalls = [
            {
              to: BUMP_TOKEN_ADDRESS as Address,
              data: transferTreasuryData,
              value: BigInt(0),
            },
            zeroXSwapTx, // 0x swap transaction
            {
              to: BASE_WETH_ADDRESS as Address,
              data: unwrapWethData,
              value: BigInt(0),
            },
            {
              to: UNISWAP_UNIVERSAL_ROUTER as Address,
              data: distributionData,
              value: BigInt(0),
            },
          ]

          // Try batch execution
          if (typeof (smartWalletClient as any).sendTransactions === 'function') {
            console.log("📦 Using sendTransactions() method...")
            txHash = await Promise.race([
              (smartWalletClient as any).sendTransactions(batchCalls),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
              })
            ]) as `0x${string}`
          } else if (typeof (smartWalletClient as any).executeBatch === 'function') {
            console.log("📦 Using executeBatch() method...")
            txHash = await Promise.race([
              (smartWalletClient as any).executeBatch(batchCalls),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
              })
            ]) as `0x${string}`
          } else {
            // Sequential execution as fallback
            console.log("📦 Batch method not available, executing sequentially...")
            let currentHash: `0x${string}` | null = null
            
            for (let i = 0; i < batchCalls.length; i++) {
              console.log(`  Step ${i + 1}/${batchCalls.length}...`)
              currentHash = await Promise.race([
                smartWalletClient.sendTransaction(batchCalls[i]),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
              
              if (i < batchCalls.length - 1 && publicClient) {
                await publicClient.waitForTransactionReceipt({ hash: currentHash })
              }
            }
            
            txHash = currentHash
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

